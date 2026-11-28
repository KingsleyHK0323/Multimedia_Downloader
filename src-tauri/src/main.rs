// Multimedia Downloader V4.0 — Tauri desktop shell.
//
// Design: one Python engine sidecar process PER operation. Write one JSON
// request line, stream its event lines back to the webview as "engine-event",
// finish on the terminal response. `stop_engine` requests cooperative
// cancellation over stdin. The engine emits i18n KEYS for the frontend.
//
// Sidecar resolution (see `sidecar_program`):
//   * dev (debug):   `python ../engine_sidecar.py` (cwd is src-tauri/)
//   * packaged:      the bundled PyInstaller `engine_sidecar(.exe)` from the
//                    Tauri resource dir (no Python needed on the user's machine).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::VecDeque;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::path::BaseDirectory;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

const RESERVATION_TTL: Duration = Duration::from_secs(120);
const COMPLETED_TTL: Duration = Duration::from_secs(300);
const COMPLETED_LIMIT: usize = 128;

struct Reservation {
    id: String,
    command: String,
    expires_at: Instant,
    cancelled: bool,
}

struct TerminalRecord {
    id: String,
    expires_at: Instant,
    confirmed_error: Option<String>,
}

#[derive(Default)]
enum OperationPhase {
    #[default]
    Idle,
    Reserved(Reservation),
    Starting { id: Option<String>, cancelled: bool },
    Running(Option<String>),
}

#[derive(Debug, PartialEq, Eq)]
enum StopDisposition {
    Reserved,
    Running,
    Missing,
}

/// A reservation is single-use; an old ID can never stop a later operation.
struct EngineLifecycle {
    instance_id: String,
    next_id: u64,
    phase: OperationPhase,
    completed: VecDeque<TerminalRecord>,
    released: VecDeque<(String, Instant)>,
}

impl Default for EngineLifecycle {
    fn default() -> Self {
        // A process-specific identifier prevents a restarted backend from
        // presenting its idle state as evidence about an earlier instance.
        let random = RandomState::new();
        let mut first = random.build_hasher();
        first.write_u8(0);
        let mut second = random.build_hasher();
        second.write_u8(1);
        Self {
            instance_id: format!("desktop-{:016x}{:016x}", first.finish(), second.finish()),
            next_id: 0,
            phase: OperationPhase::Idle,
            completed: VecDeque::new(),
            released: VecDeque::new(),
        }
    }
}

impl EngineLifecycle {
    fn expire_at(&mut self, now: Instant) {
        if matches!(&self.phase, OperationPhase::Reserved(r) if r.expires_at <= now) {
            self.phase = OperationPhase::Idle;
        }
        self.completed.retain(|record| record.expires_at > now);
        self.released.retain(|(_, expires_at)| *expires_at > now);
    }

    fn prepare(&mut self, command: &str) -> Result<String, String> {
        self.expire_at(Instant::now());
        if !matches!(command, "download" | "convert" | "run_queue") {
            return Err("unsupported operation command".into());
        }
        if !matches!(&self.phase, OperationPhase::Idle) {
            return Err("another operation is already running".into());
        }
        self.next_id = self.next_id.checked_add(1).ok_or("operation ID exhausted")?;
        let id = format!("{}-{}", self.instance_id, self.next_id);
        self.phase = OperationPhase::Reserved(Reservation {
            id: id.clone(),
            command: command.to_string(),
            expires_at: Instant::now() + RESERVATION_TTL,
            cancelled: false,
        });
        Ok(id)
    }

    /// Claim the matching reservation before spawning a sidecar process.
    fn claim(&mut self, id: Option<&str>, command: &str) -> Result<(), String> {
        self.expire_at(Instant::now());
        match (&self.phase, id) {
            (OperationPhase::Reserved(r), Some(id)) if r.id == id && r.command == command => {
                let cancelled = r.cancelled;
                self.phase = OperationPhase::Starting { id: Some(id.to_string()), cancelled };
                Ok(())
            }
            (OperationPhase::Idle, None) => {
                self.phase = OperationPhase::Starting { id: None, cancelled: false };
                Ok(())
            }
            (_, Some(_)) => Err("invalid or expired operation reservation".into()),
            _ => Err("another operation is already running".into()),
        }
    }

    /// Transition only this claimed operation to running and return its stop flag.
    fn activate(&mut self, id: Option<&str>) -> Result<bool, String> {
        match &self.phase {
            OperationPhase::Starting { id: active, cancelled } if active.as_deref() == id => {
                let cancelled = *cancelled;
                self.phase = OperationPhase::Running(id.map(|value| value.to_string()));
                Ok(cancelled)
            }
            _ => Err("operation is no longer starting".into()),
        }
    }

    fn stop(&mut self, id: &str) -> StopDisposition {
        self.expire_at(Instant::now());
        match &mut self.phase {
            OperationPhase::Reserved(r) if r.id == id => {
                r.cancelled = true;
                StopDisposition::Reserved
            }
            OperationPhase::Starting { id: Some(active), cancelled } if active.as_str() == id => {
                *cancelled = true;
                StopDisposition::Reserved
            }
            OperationPhase::Running(Some(active)) if active.as_str() == id => StopDisposition::Running,
            _ => StopDisposition::Missing,
        }
    }

    fn release(&mut self, id: &str) -> bool {
        self.expire_at(Instant::now());
        if matches!(&self.phase, OperationPhase::Reserved(r) if r.id == id) {
            self.phase = OperationPhase::Idle;
            self.released.push_back((id.to_string(), Instant::now() + COMPLETED_TTL));
            while self.released.len() > COMPLETED_LIMIT {
                let _ = self.released.pop_front();
            }
            return true;
        }
        false
    }

    /// `completed` indicates termination only; it does not imply success.
    fn status(&mut self, id: &str) -> &'static str {
        self.expire_at(Instant::now());
        match &self.phase {
            OperationPhase::Reserved(r) if r.id == id => return "reserved",
            OperationPhase::Starting { id: Some(active), .. } if active.as_str() == id => return "running",
            OperationPhase::Running(Some(active)) if active.as_str() == id => return "running",
            _ => {}
        }
        if self.completed.iter().any(|record| record.id == id) {
            "completed"
        } else if self.released.iter().any(|(released_id, _)| released_id == id) {
            "released"
        } else {
            "unknown"
        }
    }

    fn is_idle(&self) -> bool {
        matches!(&self.phase, OperationPhase::Idle)
    }

    fn confirmed_error(&self, id: &str) -> Option<&str> {
        self.completed.iter().find(|record| record.id == id)
            .and_then(|record| record.confirmed_error.as_deref())
    }

    fn finish(&mut self, id: Option<&str>, confirmed_error: Option<&str>) {
        if matches!(&self.phase, OperationPhase::Running(active) if active.as_deref() == id)
            || matches!(&self.phase, OperationPhase::Starting { id: active, .. } if active.as_deref() == id)
        {
            if let Some(id) = id {
                self.completed.push_back(TerminalRecord {
                    id: id.to_string(),
                    expires_at: Instant::now() + COMPLETED_TTL,
                    confirmed_error: confirmed_error.map(|message| message.chars().take(2048).collect()),
                });
                while self.completed.len() > COMPLETED_LIMIT {
                    let _ = self.completed.pop_front();
                }
            }
            self.phase = OperationPhase::Idle;
        }
    }
}

#[derive(Default)]
struct EngineState {
    lifecycle: EngineLifecycle,
    child: Option<Child>,
}

/// Tracks the reserved or active sidecar operation for targeted cancellation.
#[derive(Default)]
struct Engine {
    state: Mutex<EngineState>,
}

/// Resolve how to launch the engine sidecar: (program, leading args).
fn sidecar_program(app: &tauri::AppHandle) -> Result<(std::path::PathBuf, Vec<String>), String> {
    if cfg!(debug_assertions) {
        // Dev: run the source script via PATH python. cwd is src-tauri/.
        Ok((std::path::PathBuf::from("python"), vec!["../engine_sidecar.py".to_string()]))
    } else {
        // Packaged: the PyInstaller onedir is bundled under resources/engine_sidecar/.
        let exe = if cfg!(windows) { "engine_sidecar/engine_sidecar.exe" } else { "engine_sidecar/engine_sidecar" };
        let path = app
            .path()
            .resolve(exe, BaseDirectory::Resource)
            .map_err(|e| format!("cannot resolve bundled sidecar: {e}"))?;
        Ok((path, vec![]))
    }
}

fn spawn_sidecar_process(app: &tauri::AppHandle) -> Result<Child, String> {
    let (program, args) = sidecar_program(app)?;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Windows: don't flash a console window on every per-operation spawn.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
        .spawn()
        .map_err(|e| format!("failed to start sidecar: {e}"))
}

fn send_sidecar_request(child: &mut Child, req: &Value) -> Result<(), String> {
    let line = format!("{}\n", req);
    child
        .stdin
        .as_mut()
        .ok_or("no stdin")?
        .write_all(line.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn spawn_sidecar(app: &tauri::AppHandle, req: &Value) -> Result<Child, String> {
    let mut child = spawn_sidecar_process(app)?;
    send_sidecar_request(&mut child, req)?;
    Ok(child)
}

/// One-shot request/response (no event stream): formats, locales, strings.
fn one_shot(app: &tauri::AppHandle, cmd: &str, args: Value) -> Result<Value, String> {
    let req = json!({ "id": cmd, "cmd": cmd, "args": args });
    let mut child = spawn_sidecar(app, &req)?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|e| e.to_string())?;
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if msg.get("type").is_some() {
            continue; // ignore stray events for one-shot calls
        }
        let _ = child.wait();
        if msg.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
        }
        return Err(msg.get("error").and_then(Value::as_str).unwrap_or("error").into());
    }
    Err("sidecar closed without a response".into())
}

/// Streaming op: emit each event as "engine-event"; block until the response.
fn terminal_reply(msg: &Value, expected_id: &str) -> Option<Result<Value, String>> {
    if msg.get("id").and_then(Value::as_str) != Some(expected_id) {
        return None;
    }
    Some(if msg.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        Ok(msg.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(msg.get("error").and_then(Value::as_str).unwrap_or("error").into())
    })
}

fn finish_stream(result: Option<Result<Value, String>>) -> Result<Value, String> {
    result.unwrap_or_else(|| Err("sidecar closed without a terminal response".into()))
}

fn streaming(app: &tauri::AppHandle, engine: &Engine, cmd: &str, args: Value, operation_id: Option<&str>)
    -> Result<Value, String>
{
    {
        let mut state = engine.state.lock().map_err(|_| "engine state is unavailable")?;
        state.lifecycle.claim(operation_id, cmd)?;
    }
    // Spawn without sending work so a stop during process startup can be stored.
    let mut child = match spawn_sidecar_process(app) {
        Ok(child) => child,
        Err(error) => {
            let mut state = engine.state.lock().map_err(|_| "engine state is unavailable")?;
            state.lifecycle.finish(operation_id, Some(&error));
            return Err(error);
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let mut state = engine.state.lock().map_err(|_| "engine state is unavailable")?;
            state.lifecycle.finish(operation_id, Some("no stdout"));
            return Err("no stdout".into());
        }
    };
    let mut state = engine.state.lock().map_err(|_| "engine state is unavailable")?;
    let pre_cancelled = state.lifecycle.activate(operation_id)?;
    let req = json!({ "id": cmd, "cmd": cmd, "args": args, "pre_cancelled": pre_cancelled });
    if let Err(error) = send_sidecar_request(&mut child, &req) {
        // Keep the operation marked running until the child has actually exited.
        drop(state);
        let _ = child.wait();
        let mut state = engine.state.lock().map_err(|_| "engine state is unavailable")?;
        state.lifecycle.finish(operation_id, None);
        return Err(error);
    }
    state.child = Some(child);
    drop(state);

    let mut result = None;
    let mut confirmed_reply = false;
    for line in BufReader::new(stdout).lines() {
        let line = match line {
            Ok(line) => line,
            Err(e) => {
                result = Some(Err(format!("sidecar output failed: {e}")));
                break;
            }
        };
        let Ok(mut msg) = serde_json::from_str::<Value>(&line) else { continue };
        if msg.get("type").is_some() {
            if let (Some(id), Some(event)) = (operation_id, msg.as_object_mut()) {
                event.insert("operation_id".into(), Value::String(id.to_string()));
            }
            let _ = app.emit("engine-event", msg);
        } else if let Some(reply) = terminal_reply(&msg, cmd) {
            result = Some(reply);
            confirmed_reply = true;
            break;
        }
    }
    let child = {
        let mut state = engine.state.lock().map_err(|_| "engine state is unavailable")?;
        state.child.take()
    };
    if let Some(mut child) = child {
        let _ = child.wait();
    }
    let mut state = engine.state.lock().map_err(|_| "engine state is unavailable")?;
    let confirmed_error = if confirmed_reply {
        result.as_ref().and_then(|reply| reply.as_ref().err()).map(String::as_str)
    } else {
        None
    };
    state.lifecycle.finish(operation_id, confirmed_error);
    finish_stream(result)
}

// NOTE ON ASYNC: these commands wrap `spawn_blocking` around the synchronous,
// blocking sidecar I/O (`one_shot`/`streaming`). Tauri runs a plain `fn`
// command directly on the main thread — the same thread that pumps the
// window's OS message loop. A download/convert/AI-plan can block for seconds
// to minutes, which starves that loop and makes Windows/macOS/Linux flag the
// window as "Not Responding". Moving the blocking work onto a background
// thread via `spawn_blocking` (and `.await`ing it from an `async fn` command)
// keeps the main thread free the whole time. `Engine` state is fetched
// *inside* the spawned closure (via `app.state::<Engine>()`) rather than
// taken as a `State<'_, Engine>` parameter, since the closure must be
// `'static` and `State` borrows from the call.
#[tauri::command]
async fn get_formats(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || one_shot(&app, "formats", json!({})))
        .await
        .map_err(|e| format!("background task failed: {e}"))?
}

#[tauri::command]
async fn get_locales(app: tauri::AppHandle) -> Result<Value, String> {
    // Frontend expects the {code: name} map directly.
    tauri::async_runtime::spawn_blocking(move || {
        Ok(one_shot(&app, "locales", json!({}))?
            .get("available")
            .cloned()
            .unwrap_or(Value::Null))
    })
    .await
    .map_err(|e| format!("background task failed: {e}"))?
}

#[tauri::command]
async fn preview_convert(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        one_shot(&app, "preview_convert", json!({
            "files": args.get("files"),
            "dst_fmt": args.get("dst_fmt"),
            "save_path": args.get("save_path"),
            "require_absolute_paths": true,
        }))
    })
    .await
    .map_err(|e| format!("background task failed: {e}"))?
}

// OpenAI-Codex_Fork_Source_Code: preview the queue's explicit source/destination pairs.
#[tauri::command]
async fn preview_queue(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        one_shot(&app, "preview_queue", json!({
            "tasks": args.get("tasks"),
            "require_absolute_paths": true,
        }))
    })
    .await
    .map_err(|e| format!("background task failed: {e}"))?
}

// OpenAI-Codex_Fork_Source_Code: metadata-only playlist preview, without a download operation.
#[tauri::command]
async fn preview_playlist(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        one_shot(&app, "preview_playlist", json!({
            "url": args.get("url"),
            "options": {
                "save_path": "",
                "mode": args.get("mode").cloned().unwrap_or_else(|| json!("video")),
                "video_fmt": args.get("video_fmt").cloned().unwrap_or_else(|| json!("mp4")),
                "audio_fmt": args.get("audio_fmt").cloned().unwrap_or_else(|| json!("mp3")),
                "quality": args.get("quality").cloned().unwrap_or_else(|| json!("best")),
                "browser": args.get("browser").cloned().unwrap_or_else(|| json!("none")),
                "cookie_file": args.get("cookie_file"),
                "bitrate": args.get("bitrate").cloned().unwrap_or_else(|| json!("192")),
            },
            "require_absolute_paths": true,
        }))
    })
    .await
    .map_err(|e| format!("background task failed: {e}"))?
}

#[tauri::command]
async fn start_download(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let engine = app.state::<Engine>();
        let operation_id = args.get("operation_id").and_then(Value::as_str)
            .ok_or("operation_id is required")?.to_string();
        // Map the frontend DownloadArgs into the sidecar's {urls, options} shape.
        let options = json!({
            "save_path": args.get("save_path"),
            "mode": args.get("mode"),
            "video_fmt": args.get("video_fmt"),
            "audio_fmt": args.get("audio_fmt"),
            "quality": args.get("quality"),
            "browser": args.get("browser"),
            "cookie_file": args.get("cookie_file"),
            "bitrate": args.get("bitrate").and_then(Value::as_str).unwrap_or("192"),
            // OpenAI-Codex_Fork_Source_Code: selected playlist entries stay individual.
            "noplaylist": args.get("noplaylist").cloned().unwrap_or_else(|| json!(false)),
        });
        streaming(&app, &engine, "download",
            json!({ "urls": args.get("urls"), "options": options, "require_absolute_paths": true }),
            Some(&operation_id))
    })
    .await
    .map_err(|e| format!("background task failed: {e}"))?
}

#[tauri::command]
async fn start_convert(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let operation_id = args.get("operation_id").and_then(Value::as_str)
            .ok_or("operation_id is required")?.to_string();
        let policy = args.get("conflict_policy").and_then(Value::as_str).unwrap_or("rename");
        if policy == "overwrite" && args.get("overwrite_confirmed").and_then(Value::as_bool) != Some(true) {
            return Err("overwrite requires explicit confirmation".into());
        }
        let engine = app.state::<Engine>();
        streaming(&app, &engine, "convert", json!({
            "files": args.get("files"),
            "dst_fmt": args.get("dst_fmt"),
            "save_path": args.get("save_path"),
            "conflict_policy": policy,
            // OpenAI-Codex_Fork_Source_Code: retain raw enum validation in the sidecar.
            "video_encoder": args.get("video_encoder").cloned().unwrap_or_else(|| json!("software")),
            // OpenAI-Codex_app_ui: forward only a strict boolean confirmation.
            "overwrite_confirmed": args.get("overwrite_confirmed").and_then(Value::as_bool) == Some(true),
            "require_absolute_paths": true,
        }), Some(&operation_id))
    })
    .await
    .map_err(|e| format!("background task failed: {e}"))?
}

#[tauri::command]
async fn run_queue(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let operation_id = args.get("operation_id").and_then(Value::as_str)
            .ok_or("operation_id is required")?.to_string();
        let overwrite_requested = args.get("tasks").and_then(Value::as_array)
            .is_some_and(|tasks| tasks.iter().any(|task|
                task.get("conflict_policy").and_then(Value::as_str) == Some("overwrite")));
        if overwrite_requested && args.get("overwrite_confirmed").and_then(Value::as_bool) != Some(true) {
            return Err("overwrite requires explicit confirmation".into());
        }
        let engine = app.state::<Engine>();
        let mut request = args;
        let object = request.as_object_mut().ok_or("queue arguments must be an object")?;
        object.insert("require_absolute_paths".into(), Value::Bool(true));
        streaming(&app, &engine, "run_queue", request, Some(&operation_id))
    })
    .await
    .map_err(|e| format!("background task failed: {e}"))?
}

#[tauri::command]
async fn ai_plan(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
    // args is already {api_key, prompt, context} — passes straight through to
    // the sidecar's ai_plan command. NEVER executes anything (see D4); the
    // frontend calls run_queue separately, only after the user confirms.
    tauri::async_runtime::spawn_blocking(move || {
        let engine = app.state::<Engine>();
        streaming(&app, &engine, "ai_plan", args, None)
    })
    .await
    .map_err(|e| format!("background task failed: {e}"))?
}

#[tauri::command]
async fn prepare_operation(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let command = args.get("command").and_then(Value::as_str).ok_or("command is required")?;
        let engine = app.state::<Engine>();
        let mut state = engine.state.lock().map_err(|_| "engine state is unavailable")?;
        let id = state.lifecycle.prepare(command)?;
        Ok(json!({"operation_id": id, "command": command, "expires_in": 120,
                  "instance_id": state.lifecycle.instance_id.as_str()}))
    }).await.map_err(|e| format!("background task failed: {e}"))?
}

#[tauri::command]
async fn release_operation(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let id = args.get("operation_id").and_then(Value::as_str).ok_or("operation_id is required")?;
        let engine = app.state::<Engine>();
        let mut state = engine.state.lock().map_err(|_| "engine state is unavailable")?;
        Ok(json!({"released": state.lifecycle.release(id)}))
    }).await.map_err(|e| format!("background task failed: {e}"))?
}

#[tauri::command]
async fn operation_status(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let id = args.get("operation_id").and_then(Value::as_str).ok_or("operation_id is required")?;
        let engine = app.state::<Engine>();
        let mut state = engine.state.lock().map_err(|_| "engine state is unavailable")?;
        let operation_state = state.lifecycle.status(id);
        let idle = state.lifecycle.is_idle();
        let confirmed_error = state.lifecycle.confirmed_error(id);
        Ok(json!({"state": operation_state, "instance_id": state.lifecycle.instance_id.as_str(),
                  "idle": idle, "confirmed_error": confirmed_error}))
    }).await.map_err(|e| format!("background task failed: {e}"))?
}

#[tauri::command]
async fn stop_engine(app: tauri::AppHandle, args: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let id = args.get("operation_id").and_then(Value::as_str).ok_or("operation_id is required")?;
        let engine = app.state::<Engine>();
        let mut state = engine.state.lock().map_err(|_| "engine state is unavailable")?;
        match state.lifecycle.stop(id) {
            StopDisposition::Reserved => Ok(json!({"stopping": true})),
            StopDisposition::Missing => Ok(json!({"stopping": false})),
            StopDisposition::Running => {
                let child = state.child.as_mut().ok_or("sidecar is unavailable")?;
                let stdin = child.stdin.as_mut().ok_or("sidecar input is unavailable")?;
                let request = json!({"id": "stop", "cmd": "stop", "args": {}});
                stdin.write_all(format!("{request}\n").as_bytes()).map_err(|e| e.to_string())?;
                stdin.flush().map_err(|e| e.to_string())?;
                Ok(json!({"stopping": true}))
            }
        }
    }).await.map_err(|e| format!("background task failed: {e}"))?
}

#[cfg(test)]
mod operation_response_tests {
    use super::{finish_stream, terminal_reply, EngineLifecycle, StopDisposition};
    use serde_json::json;
    use std::time::{Duration, Instant};

    #[test]
    fn stop_acknowledgement_is_not_the_download_result() {
        let stop = json!({"id": "stop", "ok": true, "result": {"stopping": true}});
        assert_eq!(terminal_reply(&stop, "download"), None);
        let done = json!({"id": "download", "ok": true, "result": {"results": []}});
        assert_eq!(terminal_reply(&done, "download"), Some(Ok(json!({"results": []}))));
    }

    #[test]
    fn unexpected_end_of_stream_is_not_reported_as_success() {
        assert!(finish_stream(None).is_err());
    }

    #[test]
    fn stop_before_start_is_bound_to_its_reservation() {
        let mut lifecycle = EngineLifecycle::default();
        let first = lifecycle.prepare("download").unwrap();
        assert_eq!(lifecycle.stop(&first), StopDisposition::Reserved);
        lifecycle.claim(Some(&first), "download").unwrap();
        assert!(lifecycle.activate(Some(&first)).unwrap());
        lifecycle.finish(Some(&first), None);
        let second = lifecycle.prepare("convert").unwrap();
        assert_eq!(lifecycle.stop(&first), StopDisposition::Missing);
        lifecycle.claim(Some(&second), "convert").unwrap();
        assert_eq!(lifecycle.stop(&first), StopDisposition::Missing);
        assert!(!lifecycle.activate(Some(&second)).unwrap());
        assert_eq!(lifecycle.stop(&second), StopDisposition::Running);
    }

    #[test]
    fn stop_during_process_startup_is_preserved_before_sending_work() {
        let mut lifecycle = EngineLifecycle::default();
        let id = lifecycle.prepare("download").unwrap();
        lifecycle.claim(Some(&id), "download").unwrap();
        assert_eq!(lifecycle.stop(&id), StopDisposition::Reserved);
        assert!(lifecycle.activate(Some(&id)).unwrap());
    }

    #[test]
    fn expired_or_repeated_reservations_cannot_start() {
        let mut lifecycle = EngineLifecycle::default();
        let first = lifecycle.prepare("download").unwrap();
        lifecycle.expire_at(Instant::now() + Duration::from_secs(121));
        assert!(lifecycle.claim(Some(&first), "download").is_err());
        let second = lifecycle.prepare("convert").unwrap();
        assert!(lifecycle.claim(Some(&second), "download").is_err());
        lifecycle.claim(Some(&second), "convert").unwrap();
        assert!(lifecycle.claim(Some(&second), "convert").is_err());
        lifecycle.finish(Some(&first), None);
        assert!(!lifecycle.activate(Some(&second)).unwrap());
        assert_eq!(lifecycle.stop(&second), StopDisposition::Running);
    }

    #[test]
    fn status_does_not_treat_release_false_as_completion() {
        let mut lifecycle = EngineLifecycle::default();
        let first = lifecycle.prepare("download").unwrap();
        assert_eq!(lifecycle.status(&first), "reserved");
        lifecycle.claim(Some(&first), "download").unwrap();
        assert!(!lifecycle.release(&first));
        assert_eq!(lifecycle.status(&first), "running");
        lifecycle.activate(Some(&first)).unwrap();
        lifecycle.finish(Some(&first), None);
        assert_eq!(lifecycle.status(&first), "completed");
        let second = lifecycle.prepare("convert").unwrap();
        assert_eq!(lifecycle.status(&first), "completed");
        assert_eq!(lifecycle.status(&second), "reserved");
        assert_eq!(lifecycle.stop(&first), StopDisposition::Missing);
        lifecycle.expire_at(Instant::now() + Duration::from_secs(301));
        assert_eq!(lifecycle.status(&first), "unknown");
    }

    #[test]
    fn released_reservation_remains_distinguishable_after_a_lost_reply() {
        let mut lifecycle = EngineLifecycle::default();
        let first = lifecycle.prepare("download").unwrap();
        assert!(lifecycle.release(&first));
        assert_eq!(lifecycle.status(&first), "released");
        assert!(lifecycle.claim(Some(&first), "download").is_err());
        let second = lifecycle.prepare("convert").unwrap();
        assert_eq!(lifecycle.stop(&first), StopDisposition::Missing);
        assert_eq!(lifecycle.status(&second), "reserved");
        lifecycle.expire_at(Instant::now() + Duration::from_secs(301));
        assert_eq!(lifecycle.status(&first), "unknown");
    }

    #[test]
    fn unknown_can_be_reconciled_only_with_the_same_idle_instance() {
        let mut lifecycle = EngineLifecycle::default();
        let instance = lifecycle.instance_id.clone();
        let first = lifecycle.prepare("download").unwrap();
        lifecycle.claim(Some(&first), "download").unwrap();
        lifecycle.activate(Some(&first)).unwrap();
        lifecycle.finish(Some(&first), None);
        lifecycle.expire_at(Instant::now() + Duration::from_secs(301));
        assert_eq!(lifecycle.status(&first), "unknown");
        assert!(lifecycle.is_idle());
        assert_eq!(lifecycle.instance_id, instance);
        let second = lifecycle.prepare("convert").unwrap();
        assert!(!lifecycle.is_idle());
        assert!(lifecycle.claim(Some(&first), "download").is_err());
        assert_eq!(lifecycle.status(&second), "reserved");
    }

    #[test]
    fn confirmed_backend_error_is_distinct_from_an_unknown_terminal_result() {
        let mut lifecycle = EngineLifecycle::default();
        let first = lifecycle.prepare("download").unwrap();
        lifecycle.claim(Some(&first), "download").unwrap();
        lifecycle.activate(Some(&first)).unwrap();
        lifecycle.finish(Some(&first), Some("sidecar rejected the path"));
        assert_eq!(lifecycle.status(&first), "completed");
        assert_eq!(lifecycle.confirmed_error(&first), Some("sidecar rejected the path"));
        let second = lifecycle.prepare("convert").unwrap();
        lifecycle.claim(Some(&second), "convert").unwrap();
        lifecycle.activate(Some(&second)).unwrap();
        lifecycle.finish(Some(&second), None);
        assert_eq!(lifecycle.status(&second), "completed");
        assert_eq!(lifecycle.confirmed_error(&second), None);
    }
}

// Updated by OpenAI-Codex_Fork_Source_Code.

// OpenAI-Codex_ai_ui_check: expose the native file chooser to the conversion tab.
#[tauri::command]
async fn select_convert_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().blocking_pick_files().unwrap_or_default().into_iter()
            .map(|entry| entry.into_path().map_err(|e| e.to_string())
                .and_then(|path| path.into_os_string().into_string()
                    .map_err(|_| "A selected path is not valid Unicode".to_string())))
            .collect()
    }).await.map_err(|e| format!("file selection failed: {e}"))?
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Engine::default())
        .invoke_handler(tauri::generate_handler![
            get_formats,
            select_convert_files,
            get_locales,
            preview_convert,
            preview_queue,
            preview_playlist,
            start_download,
            start_convert,
            run_queue,
            ai_plan,
            prepare_operation,
            release_operation,
            operation_status,
            stop_engine
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
