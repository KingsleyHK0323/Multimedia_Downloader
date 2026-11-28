// OpenAI-Codex_app_ui: deterministic, in-memory transport race checks.
import assert from "node:assert/strict";
import { OperationCoordinator } from "./operationCoordinator.ts";
import { SharedEventStream } from "./eventStream.ts";

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function fakeTimers() {
  let next = 0;
  const pending = new Map();
  return {
    pending,
    setTimer: (fn) => { const id = ++next; pending.set(id, fn); return id; },
    clearTimer: (id) => pending.delete(id),
    fire: () => { const [id, fn] = pending.entries().next().value; pending.delete(id); fn(); },
  };
}

// A stop requested before prepare settles must be acknowledged before start.
{
  const prepared = deferred(), stopped = deferred(), completed = deferred();
  const calls = [];
  const transport = {
    prepare: (command) => { calls.push(`prepare:${command}`); return prepared.promise; },
    stop: (id) => { calls.push(`stop:${id}`); return stopped.promise; },
    release: async (id) => { calls.push(`release:${id}`); },
  };
  const c = new OperationCoordinator(transport);
  const result = c.run("download", (id) => { calls.push(`start:${id}`); return completed.promise; });
  const stop = c.stop();
  await flush();
  assert.deepEqual(calls, ["prepare:download"]);
  prepared.resolve({ operation_id: "A", instance_id: "instance-A", expires_in: 120 });
  await flush();
  assert.deepEqual(calls, ["prepare:download", "stop:A"]);
  stopped.resolve({ stopping: true });
  await flush();
  assert.deepEqual(calls, ["prepare:download", "stop:A", "start:A"]);
  completed.resolve({ cancelled: true });
  assert.deepEqual(await stop, { stopping: true });
  assert.deepEqual(await result, { cancelled: true });
  assert.equal(calls.at(-1), "release:A");
}

// Failure or false acknowledgement must prevent start and release the ID.
for (const outcome of ["false", "reject"]) {
  const prepared = deferred(), calls = [];
  const c = new OperationCoordinator({
    prepare: () => prepared.promise,
    stop: async (id) => { calls.push(`stop:${id}`); if (outcome === "reject") throw new Error("offline"); return { stopping: false }; },
    release: async (id) => { calls.push(`release:${id}`); },
  });
  const run = c.run("convert", async () => { calls.push("start"); });
  const stop = c.stop();
  const settledRun = run.then(() => "resolved", () => "rejected");
  const settledStop = stop.then(() => "resolved", () => "rejected");
  prepared.resolve({ operation_id: "X", instance_id: "instance-A", expires_in: 120 });
  assert.equal(await settledRun, "rejected");
  await settledStop;
  assert.deepEqual(calls, ["stop:X", "release:X"]);
}

// A pending stop/release for A cannot leak into B or overwrite B's state.
{
  const doneA = deferred(), stopA = deferred(), releaseA = deferred(), doneB = deferred();
  const calls = [];
  let index = 0;
  const c = new OperationCoordinator({
    prepare: async () => ({ operation_id: ++index === 1 ? "A" : "B", instance_id: "instance-A", expires_in: 120 }),
    stop: (id) => { calls.push(`stop:${id}`); return id === "A" ? stopA.promise : Promise.resolve({ stopping: true }); },
    release: (id) => { calls.push(`release:${id}`); return id === "A" ? releaseA.promise : Promise.resolve(); },
  });
  const a = c.run("download", () => doneA.promise);
  await flush();
  const oldStop = c.stop();
  await flush();
  doneA.resolve("A done");
  await flush();
  assert.equal(await c.run("convert", () => doneB.promise).then(() => "accepted", () => "busy"), "busy");
  stopA.resolve({ stopping: true });
  await flush();
  assert.ok(calls.includes("release:A"));
  releaseA.resolve();
  await Promise.all([a, oldStop]);
  const b = c.run("convert", () => doneB.promise);
  await flush();
  assert.equal(c.acceptsEvent({ operation_id: "A" }), false);
  assert.equal(c.acceptsEvent({ operation_id: "B" }), true);
  assert.equal(c.acceptsEvent({ type: "progress" }), false);
  await c.stop();
  doneB.resolve("B done");
  assert.equal(await b, "B done");
  assert.deepEqual(calls, ["stop:A", "release:A", "stop:B", "release:B"]);
}

// A timed-out prepare must not start; a late reservation is released by ID.
{
  const timers = fakeTimers(), prepared = deferred(), calls = [], issues = [];
  const c = new OperationCoordinator({
    prepare: () => prepared.promise,
    stop: async (id) => { calls.push(`stop:${id}`); return { stopping: true }; },
    release: async (id) => { calls.push(`release:${id}`); },
  }, { ...timers, timeoutMs: 10, onUncertain: (phase) => issues.push(phase) });
  const run = c.run("download", async () => { calls.push("start"); });
  const stop = c.stop();
  const runResult = run.then(() => "resolved", () => "rejected");
  const stopResult = stop.then(() => "resolved", () => "rejected");
  await flush();
  assert.equal(timers.pending.size, 1);
  timers.fire();
  assert.equal(await runResult, "rejected");
  assert.equal(await stopResult, "rejected");
  assert.ok(issues.includes("prepare"));
  prepared.resolve({ operation_id: "late-A", instance_id: "instance-A", expires_in: 120 });
  await flush();
  assert.deepEqual(calls, ["release:late-A"]);
}

// Slow stop/release cannot hold A forever or update UI state after B begins.
{
  const timers = fakeTimers(), doneA = deferred(), stopA = deferred(), releaseA = deferred(), doneB = deferred();
  const calls = [], issues = [], ui = [];
  let index = 0;
  const c = new OperationCoordinator({
    prepare: async () => ({ operation_id: ++index === 1 ? "A" : "B", instance_id: "instance-A", expires_in: 120 }),
    stop: (id) => { calls.push(`stop:${id}`); return id === "A" ? stopA.promise : Promise.resolve({ stopping: true }); },
    release: (id) => { calls.push(`release:${id}`); return id === "A" ? releaseA.promise : Promise.resolve(); },
  }, { ...timers, timeoutMs: 10, onUncertain: (phase) => issues.push(phase) });
  const a = c.run("download", () => doneA.promise);
  await flush();
  const stop = c.stop().then(() => ui.push("A stop replied"), () => ui.push("A stop timed out"));
  await flush();
  doneA.resolve("A done");
  await flush();
  timers.fire();
  await flush();
  assert.deepEqual(ui, ["A stop timed out"]);
  assert.ok(calls.includes("release:A"));
  timers.fire();
  assert.equal(await a, "A done");
  await stop;
  const b = c.run("convert", () => doneB.promise);
  await flush();
  stopA.resolve({ stopping: true });
  releaseA.resolve();
  await flush();
  assert.deepEqual(ui, ["A stop timed out"]);
  assert.equal(c.acceptsEvent({ operation_id: "B" }), true);
  await c.stop();
  doneB.resolve("B done");
  await b;
  assert.deepEqual(calls, ["stop:A", "release:A", "stop:B", "release:B"]);
  assert.ok(issues.includes("stop") && issues.includes("release"));
}

// A stream that disconnects during prepare or an expired reservation cannot start.
for (const reason of ["disconnected", "expired"]) {
  const prepared = deferred(), calls = [];
  let ready = true, now = 0;
  const c = new OperationCoordinator({
    prepare: () => prepared.promise,
    stop: async () => ({ stopping: true }),
    release: async (id) => { calls.push(`release:${id}`); },
  }, { canStart: () => ready, now: () => now });
  const run = c.run("download", async () => { calls.push("start"); });
  const result = run.then(() => "resolved", () => "rejected");
  await flush();
  if (reason === "disconnected") ready = false;
  else now = 120001;
  prepared.resolve({ operation_id: "guarded", instance_id: "instance-A", expires_in: 120 });
  assert.equal(await result, "rejected");
  assert.deepEqual(calls, ["release:guarded"]);
}

// Pre-cancellation does not bypass a subsequently disconnected stream.
{
  const prepared = deferred(), calls = [];
  let ready = true;
  const c = new OperationCoordinator({
    prepare: () => prepared.promise,
    stop: async (id) => { calls.push(`stop:${id}`); return { stopping: true }; },
    release: async (id) => { calls.push(`release:${id}`); },
  }, { canStart: () => ready });
  const run = c.run("convert", async () => { calls.push("start"); });
  const stop = c.stop();
  const result = run.then(() => "resolved", () => "rejected");
  ready = false;
  prepared.resolve({ operation_id: "cancelled-offline", instance_id: "instance-A", expires_in: 120 });
  assert.equal((await stop).stopping, true);
  assert.equal(await result, "rejected");
  assert.deepEqual(calls, ["stop:cancelled-offline", "release:cancelled-offline"]);
}

// A single fake EventSource drives both subscribers and observable state.
{
  const sources = [], timers = new Map(), states = [], seen = [];
  let nextTimer = 0;
  const stream = new SharedEventStream({
    create: () => {
      const es = { onopen: null, onmessage: null, onerror: null, closed: false, close() { this.closed = true; } };
      sources.push(es);
      return es;
    },
    setTimer: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimer: (id) => timers.delete(id),
    timeoutMs: 45000,
  });
  const offState = stream.observe((state) => states.push(state));
  const offApp = stream.subscribe((event) => seen.push(`app:${event.type}`));
  const offAi = stream.subscribe((event) => seen.push(`ai:${event.type}`));
  assert.equal(sources.length, 1);
  const first = sources[0];
  first.onerror();
  assert.equal(states.at(-1), "disconnected");
  assert.equal(first.closed, false);
  first.onopen();
  assert.equal(states.at(-1), "open");
  first.onmessage({ data: JSON.stringify({ type: "heartbeat" }) });
  first.onmessage({ data: JSON.stringify({ type: "progress" }) });
  assert.deepEqual(seen, ["app:progress", "ai:progress"]);
  first.onerror();
  assert.equal(states.at(-1), "disconnected");
  first.onopen();
  assert.equal(states.at(-1), "open");
  const staleOpen = first.onopen;
  stream.retry();
  assert.equal(first.closed, true);
  assert.equal(sources.length, 2);
  staleOpen();
  assert.notEqual(states.at(-1), "open");
  sources[1].onopen();
  const timeout = [...timers.values()].at(-1);
  timeout();
  assert.equal(states.at(-1), "disconnected");
  assert.equal(sources[1].closed, true);
  assert.equal(sources.length, 3);
  offAi();
  assert.equal(sources[2].closed, false);
  offApp();
  assert.equal(sources[2].closed, true);
  assert.equal(timers.size, 0);
  offState();
}

// Disconnected event delivery never blocks a separately addressed stop.
{
  let stopped = "";
  const done = deferred();
  const c = new OperationCoordinator({
    prepare: async () => ({ operation_id: "offline-job", instance_id: "instance-A", expires_in: 120 }),
    stop: async (id) => { stopped = id; return { stopping: true }; },
    release: async () => {},
  });
  const run = c.run("run_queue", () => done.promise);
  await flush();
  assert.deepEqual(await c.stop(), { stopping: true });
  assert.equal(stopped, "offline-job");
  done.resolve();
  await run;
}

// OpenAI-Codex_engine_cli: one faulty subscriber must not suppress other consumers.
{
  const clock = fakeTimers(), failures = [], observed = [], received = [];
  let source, brokenListenerCalls = 0;
  const stream = new SharedEventStream({
    ...clock,
    create: () => {
      source = { onopen: null, onmessage: null, onerror: null, close() {} };
      return source;
    },
  });
  stream.observe((state) => { if (state === "open") throw new Error("synthetic observer failure"); });
  stream.observe((state) => observed.push(state));
  stream.subscribe(() => { brokenListenerCalls++; throw new Error("synthetic listener failure"); });
  stream.subscribe((event) => received.push(event.type));
  const originalTimer = [...clock.pending.keys()][0];
  try { source.onopen(); } catch { failures.push("observer error escaped"); }
  if (!observed.includes("open")) failures.push("observer skipped");
  if (clock.pending.size !== 1 || [...clock.pending.keys()][0] === originalTimer) {
    failures.push("watchdog not rearmed");
  }
  source.onmessage({ data: JSON.stringify({ type: "heartbeat" }) });
  if (brokenListenerCalls !== 0 || received.length !== 0) failures.push("heartbeat delivered");
  source.onmessage({ data: JSON.stringify({ type: "progress" }) });
  if (brokenListenerCalls !== 1 || received.join(",") !== "progress") {
    failures.push("listener skipped");
  }
  assert.deepEqual(failures, []);
}

// OpenAI-Codex_engine_cli: a broken initial observer must not block unsubscription.
{
  const stream = new SharedEventStream({ create: () => { throw new Error("unused fake"); } });
  let unsubscribe;
  try { unsubscribe = stream.observe(() => { throw new Error("synthetic initial observer failure"); }); }
  catch { /* Checked below without aborting the other cases. */ }
  assert.equal(typeof unsubscribe, "function", "observer registration must still return cleanup");
  if (typeof unsubscribe === "function") unsubscribe();
}

// OpenAI-Codex_engine_cli: repeated callback registration keeps Set semantics.
{
  const clock = fakeTimers();
  let source, count = 0;
  const stream = new SharedEventStream({
    ...clock,
    create: () => {
      source = { onopen: null, onmessage: null, onerror: null, close() {} };
      return source;
    },
  });
  const listener = () => { count++; };
  const offFirst = stream.subscribe(listener);
  const offSecond = stream.subscribe(listener);
  source.onopen();
  source.onmessage({ data: JSON.stringify({ type: "progress" }) });
  offFirst();
  source.onmessage({ data: JSON.stringify({ type: "progress" }) });
  offSecond();
  assert.equal(count, 1, "duplicate listeners must remain deduplicated");
}

console.log("Transport race and event-stream checks passed.");
