// OpenAI-Codex_app_ui: keep stop and cleanup scoped to one reservation.
export type OperationCommand = "download" | "convert" | "run_queue";
export type StopReply = { stopping: boolean };
export type Reservation = { operation_id: string; instance_id: string; expires_in: number; command?: string };
export type OperationState = "reserved" | "running" | "completed" | "released" | "unknown";
export type LostOutcome = "completed" | "not_started" | "unknown_idle";
export type OperationStatus = { state: OperationState; instance_id: string; idle: boolean; confirmed_error?: string };

export class HttpResponseError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpResponseError";
    this.status = status;
  }
}

export interface ReservationTransport {
  prepare(command: OperationCommand): Promise<Reservation>;
  stop(operationId: string): Promise<StopReply>;
  release(operationId: string): Promise<{ released: boolean }>;
  status(operationId: string): Promise<OperationStatus>;
}

type Timer = ReturnType<typeof setTimeout>;
type Phase = "prepare" | "start" | "stop" | "release" | "status";
type CoordinatorOptions = {
  timeoutMs?: number;
  setTimer?: (callback: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  onUncertain?: (phase: Phase) => void;
  onLostOutcome?: (outcome: LostOutcome, recognizedError: boolean) => void;
  canStart?: () => boolean;
  now?: () => number;
};

type Operation = {
  id: string | null;
  prepared: Promise<string>;
  stopAttempt?: Promise<StopReply>;
  started: boolean;
  terminal: boolean;
  expired?: () => boolean;
  cleanupComplete?: boolean;
  instanceId?: string;
};

export class OperationCoordinator {
  private active: Operation | null = null;
  private readonly transport: ReservationTransport;
  private readonly options: CoordinatorOptions;

  constructor(transport: ReservationTransport, options: CoordinatorOptions = {}) {
    this.transport = transport;
    this.options = options;
  }

  private uncertain(phase: Phase): void {
    try { this.options.onUncertain?.(phase); } catch { /* Observers must not alter operation state. */ }
  }

  private bounded<T>(promise: Promise<T>, phase: Phase, onTimeout?: () => void): Promise<T> {
    const setTimer = this.options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
    const clearTimer = this.options.clearTimer ?? ((timer: Timer) => clearTimeout(timer));
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimer(() => {
        if (settled) return;
        settled = true;
        onTimeout?.();
        if (phase !== "status") this.uncertain(phase);
        reject(new Error(`${phase} request timed out; operation state is unknown`));
      }, this.options.timeoutMs ?? 10000);
      promise.then((value) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        resolve(value);
      }, (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        reject(error);
      });
    });
  }

  private async release(id: string): Promise<boolean> {
    try {
      const result = await this.bounded(Promise.resolve().then(() => this.transport.release(id)), "release");
      return result?.released === true;
    } catch { this.uncertain("release"); return false; }
  }

  private async waitForLostOutcome(id: string, instanceId: string): Promise<{ outcome: LostOutcome; confirmedError?: string }> {
    const setTimer = this.options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
    let retryDelay = 1000;
    for (;;) {
      let state: OperationState | undefined;
      let idle = false;
      let confirmedError: string | undefined;
      try {
        const result = await this.bounded(Promise.resolve().then(() => this.transport.status(id)), "status");
        if (result?.instance_id === instanceId) {
          state = result.state;
          idle = result.idle === true;
          if (result.state === "completed" && typeof result.confirmed_error === "string" && result.confirmed_error.trim()) {
            confirmedError = result.confirmed_error;
          }
        }
      } catch { /* An unavailable status cannot establish completion. */ }
      if (state === "completed") return { outcome: "completed", confirmedError };
      if (state === "released") return { outcome: "not_started" };
      if (state === "unknown" && idle) return { outcome: "unknown_idle" };
      if (state === "reserved" && await this.release(id)) return { outcome: "not_started" };
      await new Promise<void>((resolve) => { setTimer(resolve, retryDelay); });
      retryDelay = Math.min(retryDelay * 2, 30000);
    }
  }

  run<T>(command: OperationCommand, start: (id: string) => Promise<T>): Promise<T> {
    if (this.active) return Promise.reject(new Error("Another operation is already running"));
    const operation: Operation = { id: null, prepared: null as unknown as Promise<string>, started: false, terminal: false };
    this.active = operation;
    const now = this.options.now ?? (() => Date.now());
    const monotonicNow = () => typeof performance === "undefined" ? Date.now() : performance.now();
    const requestedAt = now();
    const monotonicRequestedAt = monotonicNow();
    let prepareTimedOut = false;
    const rawPrepare = Promise.resolve().then(() => this.transport.prepare(command)).then((reservation) => {
      const id = reservation?.operation_id;
      if (typeof id !== "string" || !id) throw new Error("Invalid operation reservation");
      return reservation;
    });
    operation.prepared = this.bounded(rawPrepare, "prepare", () => { prepareTimedOut = true; }).then((reservation) => {
      operation.id = reservation.operation_id;
      const expiresMs = reservation.expires_in * 1000;
      if (typeof reservation.expires_in !== "number" || !Number.isFinite(expiresMs) || expiresMs <= 0 ||
          typeof reservation.instance_id !== "string" || !reservation.instance_id ||
          (reservation.command !== undefined && reservation.command !== command)) {
        throw new Error("Invalid operation reservation");
      }
      operation.instanceId = reservation.instance_id;
      operation.expired = () => Math.max(0, now() - requestedAt, monotonicNow() - monotonicRequestedAt) >= expiresMs;
      return reservation.operation_id;
    }).catch((error: unknown) => {
      if (!prepareTimedOut) this.uncertain("prepare");
      throw error;
    });
    void rawPrepare.then((reservation) => { if (prepareTimedOut) void this.release(reservation.operation_id); }, () => {});
    return this.execute(operation, start);
  }

  private async execute<T>(operation: Operation, start: (id: string) => Promise<T>): Promise<T> {
    let lostOutcome: LostOutcome | undefined;
    let recognizedError = false;
    try {
      const id = await operation.prepared;
      if (operation.stopAttempt) {
        const reply = await operation.stopAttempt;
        if (reply?.stopping !== true) throw new Error("Stop request was not accepted before the operation started");
      }
      if (operation.expired?.()) throw new Error("Operation reservation expired before start");
      if (this.options.canStart?.() === false) throw new Error("Event stream disconnected before operation start");
      operation.started = true;
      try {
        return await start(id);
      } catch (error: unknown) {
        this.uncertain("start");
        const resolved = await this.waitForLostOutcome(id, operation.instanceId!);
        const outcome = resolved.outcome;
        recognizedError = error instanceof HttpResponseError || Boolean(resolved.confirmedError);
        lostOutcome = outcome;
        operation.cleanupComplete = true;
        if (resolved.confirmedError) throw new Error(resolved.confirmedError);
        if (error instanceof HttpResponseError || outcome === "not_started") {
          throw error instanceof Error ? error : new Error(String(error));
        }
        const diagnostic = error instanceof Error ? error.message : String(error);
        throw new Error(outcome === "completed"
          ? "The operation terminated but its final result was lost; success cannot be confirmed."
          : `The backend is idle, but the operation result is unknown; success cannot be confirmed. Diagnostic: ${diagnostic}`);
      }
    } finally {
      operation.terminal = true;
      if (operation.stopAttempt) await operation.stopAttempt.catch(() => {});
      if (operation.id && !operation.cleanupComplete) {
        const released = await this.release(operation.id);
        if (!operation.started && !released) this.uncertain("release");
      }
      if (this.active === operation) this.active = null;
      if (lostOutcome) {
        try { this.options.onLostOutcome?.(lostOutcome, recognizedError); } catch { /* Observers must not alter operation state. */ }
      }
    }
  }

  stop(): Promise<StopReply> {
    const operation = this.active;
    if (!operation || operation.terminal) return Promise.resolve({ stopping: false });
    if (operation.stopAttempt) return operation.stopAttempt;
    const attempt = operation.prepared.then((id) => {
      if (operation.terminal) return { stopping: false };
      return this.bounded(Promise.resolve().then(() => this.transport.stop(id)), "stop").catch((error: unknown) => {
        this.uncertain("stop");
        throw error;
      });
    });
    operation.stopAttempt = attempt;
    void attempt.then(
      (reply) => { if (operation.started && !reply?.stopping && operation.stopAttempt === attempt) operation.stopAttempt = undefined; },
      () => { if (operation.started && operation.stopAttempt === attempt) operation.stopAttempt = undefined; },
    );
    return attempt;
  }

  acceptsEvent(event: { operation_id?: unknown }): boolean {
    if (!this.active) return event.operation_id === undefined;
    return !this.active.terminal && !!this.active.id && event.operation_id === this.active.id;
  }
}
