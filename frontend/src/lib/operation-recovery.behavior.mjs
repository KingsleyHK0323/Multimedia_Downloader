// OpenAI-Codex_app_ui: deterministic recovery after a lost start response.
import assert from "node:assert/strict";
import { HttpResponseError, OperationCoordinator } from "./operationCoordinator.ts";

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function timers() {
  let next = 0;
  const pending = new Map();
  return {
    pending,
    setTimer: (callback, ms) => { const id = ++next; pending.set(id, { callback, ms }); return id; },
    clearTimer: (id) => pending.delete(id),
    fire: () => { const [id, entry] = pending.entries().next().value; pending.delete(id); entry.callback(); return entry.ms; },
  };
}

// An unknown state only unlocks for the original, idle backend instance.
{
  const clock = timers(), start = deferred(), outcomes = [];
  const states = [
    { state: "completed", instance_id: "restarted", idle: true, confirmed_error: "wrong instance" },
    { state: "unknown", instance_id: "restarted", idle: true },
    { state: "unknown", instance_id: "instance-A", idle: false },
    { state: "unknown", idle: true },
    { state: "unknown", instance_id: "instance-A", idle: true },
  ];
  const coordinator = new OperationCoordinator({
    prepare: async () => ({ operation_id: "A", instance_id: "instance-A", expires_in: 120 }),
    stop: async () => ({ stopping: true }),
    status: async () => states.shift(),
    release: async () => ({ released: false }),
  }, { ...clock, timeoutMs: 20, onLostOutcome: (outcome) => outcomes.push(outcome) });
  const run = coordinator.run("download", () => start.promise);
  const settled = run.then(() => null, (error) => error);
  await flush();
  start.reject(new Error("network interrupted"));
  await flush();
  for (const delay of [1000, 2000, 4000, 8000]) {
    assert.equal(coordinator.acceptsEvent({ operation_id: "A" }), true);
    assert.equal(await coordinator.run("convert", async () => {}).then(() => "accepted", () => "busy"), "busy");
    assert.equal(clock.fire(), delay);
    await flush();
  }
  const result = await settled;
  assert.match(result.message, /result is unknown/);
  assert.match(result.message, /network interrupted/);
  assert.doesNotMatch(result.message, /wrong instance/);
  assert.deepEqual(outcomes, ["unknown_idle"]);
}

// A concrete HTTP error is retained only after operation state is safe.
for (const state of ["reserved", "completed"]) {
  const error = new HttpResponseError(400, "Invalid destination");
  const outcomes = [], calls = [];
  const coordinator = new OperationCoordinator({
    prepare: async () => ({ operation_id: "bad", instance_id: "instance-A", expires_in: 120 }),
    stop: async () => ({ stopping: true }),
    status: async () => ({ state, instance_id: "instance-A", idle: false }),
    release: async (id) => { calls.push(id); return { released: true }; },
  }, { onLostOutcome: (outcome, confirmed) => outcomes.push([outcome, confirmed]) });
  const actual = await coordinator.run("convert", async () => { throw error; }).then(() => null, (e) => e);
  assert.equal(actual, error);
  assert.deepEqual(outcomes, [[state === "reserved" ? "not_started" : "completed", true]]);
  assert.deepEqual(calls, state === "reserved" ? ["bad"] : []);
}

// Only a same-instance completed status can identify a backend error.
for (const confirmed of [true, false]) {
  const outcomes = [];
  const coordinator = new OperationCoordinator({
    prepare: async () => ({ operation_id: "desktop", instance_id: "desktop-instance", expires_in: 120 }),
    stop: async () => ({ stopping: true }),
    status: async () => ({
      state: "completed", instance_id: "desktop-instance", idle: true,
      ...(confirmed ? { confirmed_error: "Sidecar rejected the operation" } : {}),
    }),
    release: async () => ({ released: false }),
  }, { onLostOutcome: (outcome, recognized) => outcomes.push([outcome, recognized]) });
  const actual = await coordinator.run("download", async () => { throw "IPC ended"; }).then(() => null, (error) => error);
  if (confirmed) assert.equal(actual.message, "Sidecar rejected the operation");
  else assert.match(actual.message, /final result was lost/);
  assert.deepEqual(outcomes, [["completed", confirmed]]);
}

// If release proves no work started, preserve the original rejection as a diagnostic.
{
  const coordinator = new OperationCoordinator({
    prepare: async () => ({ operation_id: "desktop", instance_id: "desktop-instance", expires_in: 120 }),
    stop: async () => ({ stopping: true }),
    status: async () => ({ state: "released", instance_id: "desktop-instance", idle: true, confirmed_error: "ignored for released" }),
    release: async () => ({ released: false }),
  });
  const actual = await coordinator.run("convert", async () => { throw "IPC ended"; }).then(() => null, (error) => error);
  assert.equal(actual.message, "IPC ended");
}

// A lost release response can be resolved by a later released status.
{
  const clock = timers(), start = deferred(), releaseGate = deferred(), outcomes = [];
  let checks = 0;
  const coordinator = new OperationCoordinator({
    prepare: async () => ({ operation_id: "released-A", instance_id: "instance-A", expires_in: 120 }),
    stop: async () => ({ stopping: true }),
    status: async () => ({ state: ++checks === 1 ? "reserved" : "released", instance_id: "instance-A", idle: false }),
    release: () => releaseGate.promise,
  }, { ...clock, timeoutMs: 20, onLostOutcome: (state) => outcomes.push(state) });
  const run = coordinator.run("download", () => start.promise);
  const settled = run.then(() => "resolved", () => "rejected");
  await flush();
  start.reject(new Error("lost"));
  await flush();
  assert.equal(clock.fire(), 20);
  await flush();
  assert.equal(coordinator.acceptsEvent({ operation_id: "released-A" }), true);
  assert.equal(clock.fire(), 1000);
  await flush();
  assert.equal(await settled, "rejected");
  assert.deepEqual(outcomes, ["not_started"]);
  releaseGate.resolve({ released: true });
  await flush();
  assert.deepEqual(outcomes, ["not_started"]);
}

// An unsent start with released:false leaves reservation cleanup uncertain.
{
  const issues = [];
  const coordinator = new OperationCoordinator({
    prepare: async () => ({ operation_id: "not-sent", instance_id: "instance-A", expires_in: 120 }),
    stop: async () => ({ stopping: true }),
    status: async () => ({ state: "unknown" }),
    release: async () => ({ released: false }),
  }, { canStart: () => false, onUncertain: (phase) => issues.push(phase) });
  assert.equal(await coordinator.run("download", async () => {}).then(() => "resolved", () => "rejected"), "rejected");
  assert.ok(issues.includes("release"));
}

// A running operation remains active and stoppable until completed is observed.
{
  const clock = timers(), start = deferred(), calls = [], notices = [], outcomes = [];
  const states = ["running", "unknown", "running", "completed"];
  let serial = 0;
  const coordinator = new OperationCoordinator({
    prepare: async () => ({ operation_id: ++serial === 1 ? "A" : "B", instance_id: "instance-A", expires_in: 120 }),
    stop: async (id) => { calls.push(`stop:${id}`); return { stopping: true }; },
    status: async (id) => { calls.push(`status:${id}`); return { state: states.shift(), instance_id: "instance-A", idle: false }; },
    release: async (id) => { calls.push(`release:${id}`); return { released: false }; },
  }, { ...clock, timeoutMs: 20, onUncertain: (phase) => notices.push(phase), onLostOutcome: (state) => outcomes.push(state) });
  const a = coordinator.run("download", () => start.promise);
  const settledA = a.then(() => "resolved", () => "rejected");
  await flush();
  start.reject(new Error("response lost"));
  await flush();
  assert.ok(notices.includes("start"));
  assert.deepEqual(calls, ["status:A"]);
  assert.equal(coordinator.acceptsEvent({ operation_id: "A" }), true);
  assert.equal(await coordinator.run("convert", async () => {}).then(() => "accepted", () => "busy"), "busy");
  assert.deepEqual(await coordinator.stop(), { stopping: true });
  assert.equal(clock.fire(), 1000);
  await flush();
  assert.equal(coordinator.acceptsEvent({ operation_id: "A" }), true);
  assert.equal(clock.fire(), 2000);
  await flush();
  assert.equal(clock.fire(), 4000);
  await flush();
  assert.equal(await settledA, "rejected");
  assert.deepEqual(outcomes, ["completed"]);
  assert.deepEqual(calls, ["status:A", "stop:A", "status:A", "status:A", "status:A"]);
  const bDone = deferred();
  const b = coordinator.run("convert", () => bDone.promise);
  await flush();
  assert.equal(coordinator.acceptsEvent({ operation_id: "A" }), false);
  assert.equal(coordinator.acceptsEvent({ operation_id: "B" }), true);
  bDone.resolve("B complete");
  assert.equal(await b, "B complete");
}

// Only an atomic released:true response can settle a still-reserved operation.
{
  const clock = timers(), start = deferred(), lateRelease = deferred(), calls = [], outcomes = [];
  let releases = 0;
  const coordinator = new OperationCoordinator({
    prepare: async () => ({ operation_id: "reserved-A", instance_id: "instance-A", expires_in: 120 }),
    stop: async () => ({ stopping: true }),
    status: async (id) => { calls.push(`status:${id}`); return { state: "reserved", instance_id: "instance-A", idle: false }; },
    release: (id) => {
      calls.push(`release:${id}`);
      releases++;
      if (releases === 1) return Promise.resolve({ released: false });
      if (releases === 2) return lateRelease.promise;
      return Promise.resolve({ released: true });
    },
  }, { ...clock, timeoutMs: 20, onLostOutcome: (state) => outcomes.push(state) });
  const a = coordinator.run("convert", () => start.promise);
  const settled = a.then(() => "resolved", () => "rejected");
  await flush();
  start.reject(new Error("response lost"));
  await flush();
  assert.equal(coordinator.acceptsEvent({ operation_id: "reserved-A" }), true);
  assert.deepEqual(calls, ["status:reserved-A", "release:reserved-A"]);
  assert.equal(clock.fire(), 1000);
  await flush();
  assert.equal(clock.fire(), 20);
  await flush();
  assert.equal(coordinator.acceptsEvent({ operation_id: "reserved-A" }), true);
  assert.equal(clock.fire(), 2000);
  await flush();
  assert.equal(await settled, "rejected");
  assert.deepEqual(outcomes, ["not_started"]);
  assert.deepEqual(calls, ["status:reserved-A", "release:reserved-A", "status:reserved-A", "release:reserved-A", "status:reserved-A", "release:reserved-A"]);
  lateRelease.resolve({ released: false });
  await flush();
  assert.deepEqual(outcomes, ["not_started"]);
}

// Unknown or failed status queries never clear the active operation.
{
  const clock = timers(), start = deferred(), statusGate = deferred();
  let checks = 0;
  const coordinator = new OperationCoordinator({
    prepare: async () => ({ operation_id: "uncertain", instance_id: "instance-A", expires_in: 120 }),
    stop: async () => ({ stopping: true }),
    status: async () => {
      checks++;
      if (checks === 1) return { state: "unknown", instance_id: "instance-A", idle: false };
      if (checks === 2) throw new Error("offline");
      return statusGate.promise;
    },
    release: async () => ({ released: false }),
  }, { ...clock, timeoutMs: 20 });
  const run = coordinator.run("run_queue", () => start.promise);
  const settled = run.then(() => "resolved", () => "rejected");
  await flush();
  start.reject(new Error("lost"));
  await flush();
  assert.equal(clock.fire(), 1000);
  await flush();
  assert.equal(clock.fire(), 2000);
  await flush();
  assert.equal(clock.fire(), 20);
  await flush();
  assert.equal(coordinator.acceptsEvent({ operation_id: "uncertain" }), true);
  assert.equal(await coordinator.run("download", async () => {}).then(() => "accepted", () => "busy"), "busy");
  assert.equal((await coordinator.stop()).stopping, true);
  assert.equal(clock.fire(), 4000);
  await flush();
  statusGate.resolve({ state: "completed", instance_id: "instance-A", idle: true });
  assert.equal(await settled, "rejected");
}
console.log("Lost-response recovery checks passed.");
