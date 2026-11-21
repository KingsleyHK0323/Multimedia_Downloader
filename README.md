# Multimedia Downloader — V4.3.22

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/KingsleyHK0323/Multimedia_Downloader?sort=semver)](https://github.com/KingsleyHK0323/Multimedia_Downloader/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/KingsleyHK0323/Multimedia_Downloader/total)](https://github.com/KingsleyHK0323/Multimedia_Downloader/releases)
[![Contributors](https://img.shields.io/github/contributors/KingsleyHK0323/Multimedia_Downloader)](https://github.com/KingsleyHK0323/Multimedia_Downloader/graphs/contributors)
<!-- OpenAI-Codex: release, download and contributor badges update dynamically. -->
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS%20%7C%20Web-blue)](#run-as-a-web-app-v41)
[![Built with](https://img.shields.io/badge/built%20with-Tauri%20·%20Svelte%20·%20Python-6E56CF)](#project-layout)

## License

Copyright (c) Kingsley.

The original Multimedia Downloader software code is source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE). This license does not grant
commercial use. Third-party components keep their respective terms; see their
accompanying notices, including
[`third-party/LICENSE-ffmpeg-GPLv3.txt`](third-party/LICENSE-ffmpeg-GPLv3.txt).

Earlier copies distributed with an MIT license remain subject to the terms
granted with those copies. This change applies to the current project
distribution and does not revoke earlier grants.

<!-- OpenAI-Codex: added the current software-license notice and attribution. -->
<!-- OpenAI-Codex: updated repository links. -->

A cross-platform multimedia downloader & format converter built on top of
[yt-dlp](https://github.com/yt-dlp/yt-dlp) and `ffmpeg`, with an AI assistant
for batch automation. Ships as a native desktop app (Windows / Linux / macOS)
built with [Tauri](https://tauri.app), and as a deployable web app.

> This document is in English. For 繁體中文 / 简体中文 documentation, see the
> [Wiki](https://github.com/KingsleyHK0323/Multimedia_Downloader/wiki) — the
> app's own UI stays available in all three languages regardless.

---

## Highlights

- **AI Assistant** — describe what you want in plain language ("convert every
  .mkv in this folder to mp4"); the assistant drafts a batch plan and **only
  runs it after you confirm** — nothing executes without your approval.
- **500+ sites** — YouTube, Facebook, Instagram, TikTok, BiliBili, Twitter,
  SoundCloud, Twitch, Vimeo, and every other site yt-dlp supports.
- **Audio extraction** — convert to MP3, FLAC, AAC, WAV, OGG, M4A, Opus, WMA.
- **Format conversion** — transcode any input to any output via ffmpeg
  (bundled — no separate ffmpeg install needed).
- **Tri-language UI** — English (default), Traditional Chinese, Simplified
  Chinese; switchable at runtime.
- **Form state** — download and conversion inputs remain when switching tabs;
  refreshing or closing the app resets unsaved form state.
  <!-- OpenAI-Codex_Fork_GitHub_REPO -->
- **Cookie support** — read from an installed browser, or supply a
  `cookies.txt` for Douyin / Instagram / login-gated platforms.
- **Download results** — the desktop/Web download form reports success only
  after receiving a complete matching result; missing or malformed replies are
  shown as unconfirmed. This does not resolve start/stop races.
  <!-- OpenAI-Codex_Fork_GitHub_REPO -->
- **Batch queue** — download or convert many items in one go, with live
  per-item progress and a run log. Transient download failures use the batch
  retry policy; stopping may wait for the current item and its retries.
  <!-- OpenAI-Codex_Fork_GitHub_REPO -->
- **Built-in User Manual** — a quick reference panel right in the app (header
  book icon), available in all three languages.

> [!NOTE]
> Primarily a desktop app; **V4.1** adds a real, network-deployable web version
> (see [Run as a web app](#run-as-a-web-app-v41) below). Native mobile apps are
> planned for **V5.0**.

<!-- OpenAI-Codex: describe the application identifier transition. -->
> **Installation identity:** Future builds use `com.kingsley.multimedia-downloader`. Existing installations using the previous identifier may be treated as a separate app and may require manual data migration.

## Install (end users)

1. Download the installer for your platform from the [Releases page](https://github.com/KingsleyHK0323/Multimedia_Downloader/releases/latest) (Windows: `.exe`
   or `.msi`).
2. Run it and follow the prompts.
3. Launch **Multimedia Downloader** from the Start Menu / Applications.

No separate Python or ffmpeg install is required — both are bundled inside
the app.

## Using the AI Assistant

> [!NOTE]
> The AI Assistant runtime error in the 4.0.0 build — caused by OpenRouter
> retiring the free models it was pinned to — was patched in v4.1 by swapping
> in replacements, and those were retired in turn. Since **v4.3.10** the
> assistant checks its models against OpenRouter's live catalogue on first use
> and substitutes an available free model automatically, so a retired model no
> longer breaks it.

1. Click the **✨ AI Assistant** button (or press `Ctrl/Cmd+K`).
2. First time only: open **Settings** and paste your own
   [OpenRouter](https://openrouter.ai/keys) API key. The interface can optionally save it in browser or app WebView localStorage,
   not an OS keychain. An unsaved key lasts while the AI panel remains open;
   turning off saving does not remove previously stored keys. In Web mode, the
   key is sent to the application server before OpenRouter.
   <!-- OpenAI-Codex_Fork_GitHub_REPO -->
3. Describe your task, e.g. *"Download
   https://youtube.com/watch?v=... as mp4"* or *"Convert D:\videos\a.mov and
   b.avi to mp4"*.
4. Review the generated plan, including any requested audio bitrate — **nothing runs yet**.
   <!-- OpenAI-Codex_Fork_GitHub_REPO -->
5. Click **Confirm** to execute, or **Cancel** / **Regenerate**.

## Requirements

| Component | Notes |
| --- | --- |
| Windows 10/11, Linux, or macOS | Desktop app; all three platforms built and published automatically by CI. |
| WebView2 | Pre-installed on modern Windows; the installer will prompt if missing. |
| OpenRouter API key | **Optional** — only needed to use the AI Assistant. Get one free at [openrouter.ai](https://openrouter.ai/keys). |

## Building from source (developers)

```bash
git clone https://github.com/KingsleyHK0323/Multimedia_Downloader.git
cd Multimedia_Downloader
npm install                 # installs the Tauri CLI at the project root
npm run tauri dev           # compile + run in dev mode (needs Python 3.8+, Rust, Node)
npm run tauri build         # build an installer locally, if you want one without waiting for CI
```

The frontend's TypeScript major version is kept within the range supported by
`svelte-check`; Dependabot updates to TypeScript 7 are paused until that peer
dependency supports it.

Only pull requests merged into `Source_Code` with the `release:patch` label
automatically increment the patch version, create and push the matching
`vX.Y.Z` tag, and start the three-platform release build. Merged pull requests
without that label do not create a release. The automatic release workflow can
also be run manually for a merged pull request. If another pull request
advances `Source_Code` while a release commit is being pushed, the workflow
rebases that commit onto the new branch tip and retries. Dependabot groups
minor and patch updates by ecosystem; its pull requests are merged
automatically after the full CI workflow passes, but do not trigger a release
unless they carry the `release:patch` label. Major updates remain separate
pull requests and also require CI to pass before automatic merging. PRs that
change files under
`.github/workflows/` are left for manual merging because GitHub requires a
separate Workflows permission to merge them. Put release notes under
`Unreleased` in `CHANGELOG.md`; the release workflow promotes them to the new
version entry.

Official installers are built and published automatically by GitHub Actions
(see `.github/workflows/auto-patch-release.yml` and
`.github/workflows/release.yml`) — no local release build or manual tag is
needed after a labeled pull request is merged.

The `Auto-format Python` workflow formats changed tracked Python files on pushes to `Source_Code` with Black and commits formatting changes back to that branch. It requests CI, matrix, cross-branch, container and API documentation workflows after its commit; a concurrent branch update causes its push to fail safely. (OpenAI-Codex)

After a pull request merges, the `Clean merged branches` workflow deletes its unchanged source branch when it belongs to this repository. It preserves `Source_Code` and `Multimedia_Downloader_Web_Preview`. (OpenAI-Codex)

Release builds upload installers to a draft. Automatic publication requires all six installer types and successful CI and Python matrix runs for the tagged commit; v4.3.3 remains a draft pending separate confirmation. A failed build or missing verification leaves the release unpublished. (OpenAI-Codex)

The `API documentation build` workflow generates an HTML reference for the Python engine, AI and internationalization modules as a short-lived GitHub Actions artifact and refreshes the [published API reference](https://kingsleyhk0323.github.io/Multimedia_Downloader/api/) on GitHub Pages. (OpenAI-Codex)

The `Container image` workflow builds and smoke-tests the web image on GitHub-hosted runners before pushing SHA and `edge` tags to GHCR. The service has no authentication; bind it to localhost unless you provide your own access controls. (OpenAI-Codex)

The `npm web package` workflow builds and smoke-tests an installable web package on GitHub-hosted runners. Manual development publications use a `-dev` version; verified stable releases request publication of their matching package to GitHub Packages. Package access is controlled by the package owner. (OpenAI-Codex)

The issue triage workflow classifies known area keywords in issue titles and prose (excluding fenced logs) and requests missing required form information when it applies the `needs-info` label. (OpenAI-Codex)

The `First interaction` workflow welcomes first-time issue and pull request authors. (OpenAI-Codex)

The `Stale issue and PR management` workflow warns after 30 days of inactivity and closes after 14 additional days. Items with the `keep-open`, `never-stale`, or `security` label, or a milestone, are exempt. (OpenAI-Codex)

The repository owner is listed in `.github/CODEOWNERS` for pull request review requests. GitHub does not request a review from the author of their own pull request. (OpenAI-Codex)

The `Cross-branch checks` workflow checks the current `Source_Code` version and builds the `Multimedia_Downloader_Web_Preview` branch after source pushes or completion of the preview deployment workflow. (OpenAI-Codex)

The `Python matrix tests` workflow runs the Python suite on Windows, macOS, and Linux with Python 3.10 through 3.14. (OpenAI-Codex)

The `CI` workflow runs the existing source checks on pushes and pull requests.
Every Monday at 00:17 UTC (08:17 Hong Kong time), it also runs those checks on
`Source_Code`, builds the `Multimedia_Downloader_Web_Preview` branch, and checks
that the published GitHub Pages URL returns HTTP 200 with the expected page
title. Schedule events run from the repository's default branch.

On Tuesdays at 12:00 and 12:15 UTC (20:00 and 20:15 Hong Kong time), the
`Weekly CI Watchdog` and `Weekly Dependabot Watchdog` workflows check that the
scheduled CI, preview health, dependency update scans, and open Dependabot PR
checks completed successfully. Each workflow creates or updates one GitHub
issue when its checks are missing or fail. These watchdogs report problems;
they do not change source code, update dependencies, merge pull requests, or
close their issues automatically.

Run the Python test suite:

```bash
pip install -r requirements-dev.txt          # what CI installs, in one file
python -m unittest discover -s tests         # 161 tests
```

Install that file first — the suite does not skip tests whose dependencies are
missing, it fails and tells you what to install. A skipped test reports as
success, so a partial run would otherwise print `OK` and mean nothing. To run
only part of the suite, name the module: `python -m unittest tests.test_engine`.

## Run as a web app (V4.1)

The same UI can run as a standalone, deployable web app — no desktop shell —
with a real Flask + SSE backend that drives the *same* engine (real yt-dlp /
ffmpeg, not the browser mock):

```bash
cd Multimedia_Downloader
pip install -r requirements-web.txt   # yt-dlp + Flask (ffmpeg on PATH)
npm run build:frontend:web            # build the frontend in web mode
npm run web                           # serve on http://127.0.0.1:5000
# LAN / server:
HOST=0.0.0.0 PORT=8000 MMDL_TRUSTED_HOSTS=192.168.1.12 python web_app.py
```

Because it's a browser app, downloaded/converted files land in a **server-side**
folder (`MMDL_DOWNLOADS`, default `./downloads`) retrievable at `/files/<name>`
— leave the Save-Location field blank to use it. It's a single-user model (one
operation at a time, like V3.0's `web_app.py`); for production put it behind a
streaming-friendly WSGI worker, e.g. `gunicorn -k gthread -w 1 --threads 8
web_app:app`, and add your own auth if exposing it beyond localhost.

By default only `localhost`, `127.0.0.1` and `[::1]` hosts are accepted. Set
`MMDL_TRUSTED_HOSTS` to a comma-separated list of exact hostnames or IPs; it
replaces the defaults, so include any loopback hosts still needed. Optional
`MMDL_TRUSTED_ORIGINS` lists extra exact browser origins. Configure a trusted
proxy to preserve the intended Host and scheme; forwarded headers are not
automatically trusted. These checks are not authentication.
<!-- OpenAI-Codex_Fork_GitHub_REPO -->

Paths sent by the browser are confined to that downloads folder, and a request
pointing outside it is rejected with HTTP 400 — otherwise anyone who can reach
the server could read and write files anywhere on it. The format, quality and
browser fields are checked against the engine's own catalogues for the same
reason: the requested format ends up in the output filename, so an unchecked
one steers the path straight back out of the folder. Set
`MMDL_ALLOW_ABSOLUTE_PATHS=1` to lift the restriction when you are running it
locally for yourself and want to save elsewhere on the machine.

### Run the web app with a container

The GHCR package visibility is controlled by the repository owner. Authenticate
to GHCR first if the package is private. Bind the service to localhost; it does
not provide authentication.

```sh
docker pull ghcr.io/kingsleyhk0323/multimedia_downloader:edge
docker run --rm -p 127.0.0.1:5000:5000 -v mmdl-data:/data ghcr.io/kingsleyhk0323/multimedia_downloader:edge
```

Open `http://localhost:5000`. The named volume persists downloaded files.
The `edge` tag tracks a tested development build, not a versioned release.
(OpenAI-Codex)

## Run on Android (Termux)

The desktop app can't run on Android, but the Python engine can — via
[Termux](https://termux.dev). Use it from the terminal (CLI) or as the web UI
in your phone's browser:

```bash
pkg install -y git && git clone https://github.com/KingsleyHK0323/Multimedia_Downloader.git
cd Multimedia_Downloader
bash termux/run-cli.sh download "https://youtu.be/XXXX" -o ~/storage/downloads -f mp4   # CLI
bash termux/run-web.sh                                                                  # web UI
```

Full walkthrough: [termux/README.md](termux/README.md). The CLI ([`cli.py`](cli.py))
also runs on any desktop/server with Python + ffmpeg. For audio downloads,
`--bitrate` accepts a decimal value in kbps (default `192`). The supported
encoder ultimately determines which values work.
The desktop and Web single-download forms and TUI also pass their selected bitrate.
<!-- OpenAI-Codex_Fork_GitHub_REPO -->

## Run in your terminal (TUI)

Prefer a keyboard-driven interface over the desktop GUI — or you're on a
headless server / SSH session? The desktop, Termux, and web installs all
already had a terminal-friendly path via [`cli.py`](cli.py); **V4.3** adds a
full interactive terminal UI (built with [Textual](https://textual.textualize.io))
with the same Download / Convert / Log tabs as the desktop app, driving the
*same* engine:

```bash
pip install -r requirements-tui.txt   # yt-dlp + textual (ffmpeg on PATH)
python -m tui                         # or: python -m tui --lang zh_tw
```

Keyboard shortcuts: `d` toggles light/dark, `q` quits. The language is fixed
at launch via `--lang` (like `cli.py`) rather than switchable mid-session.

## Project layout

```
Source_Code/
├── src-tauri/    Tauri shell (Rust): window, sidecar management
├── frontend/     Web UI (Svelte + Vite + TS + Tailwind)
├── engine/       Python engine: Downloader / Converter (yt-dlp + ffmpeg)
├── engine_sidecar.py   stdio IPC entrypoint spawned by the Rust shell
├── web_app.py    Flask + SSE backend for the standalone web app (V4.1)
├── cli.py        terminal CLI over the engine (great for Termux / headless)
├── tui/          interactive terminal UI (Textual) over the same engine
├── termux/       Android (Termux) launchers + guide
├── ai/           OpenRouter client + multi-model planning pipeline
├── locales/      en.json / zh_tw.json / zh_cn.json
├── packaging/    PyInstaller spec (used by CI to build the sidecar)
└── tests/        Unit tests
```

## Cookie tips

Some platforms (Douyin, private TikTok, private Instagram) refuse to serve
media without an authenticated cookie:

1. **Browser-direct (easiest)** — select the browser you are logged into in
   the download tab. yt-dlp reads its cookies for you.
2. **Manual file** — export `cookies.txt` with a browser extension (e.g.
   *Get cookies.txt LOCALLY* for Chrome/Edge/Brave, *cookies.txt* for
   Firefox).

The desktop download form accepts an absolute cookie file path for its system.
The Web download form accepts a server-side path, confined to its downloads
folder by default; `MMDL_ALLOW_ABSOLUTE_PATHS=1` permits other paths. It is not
browser file upload. A specified cookie file must exist as a regular file. If it does not, the
engine reports an error instead of falling back to browser cookies.
CLI and TUI log messages and downloader log parameters/error text redact
HTTP(S) URL userinfo, query and fragment. URL paths, other text and other
output channels can still contain sensitive information.
<!-- OpenAI-Codex_Fork_GitHub_REPO -->

## Disclaimer

This software is for personal, lawful use only. Respect each platform's terms
of service and the copyright of content owners.
