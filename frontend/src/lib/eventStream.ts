// OpenAI-Codex_app_ui: one shared, observable event stream per browser page.
export type ConnectionState = "connecting" | "open" | "disconnected";
type StreamSource = Pick<EventSource, "onopen" | "onmessage" | "onerror" | "close">;
type Timer = ReturnType<typeof setTimeout>;
type EventObject = { type: string; [key: string]: unknown };

export class SharedEventStream {
  private source: StreamSource | null = null;
  private timer: Timer | undefined;
  private state: ConnectionState = "disconnected";
  private readonly listeners = new Set<(event: EventObject) => void>();
  private readonly observers = new Set<(state: ConnectionState) => void>();
  private readonly setTimer: (callback: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly options: {
    create: () => StreamSource;
    setTimer?: (callback: () => void, ms: number) => Timer;
    clearTimer?: (timer: Timer) => void;
    timeoutMs?: number;
  };


  // OpenAI-Codex_engine_cli: isolate consumers while preserving callback identity.
  private readonly safeEvents = new WeakMap<(event: EventObject) => void, (event: EventObject) => void>();
  private readonly safeStates = new WeakMap<(state: ConnectionState) => void, (state: ConnectionState) => void>();

  private protect<T>(
    cache: WeakMap<(value: T) => void, (value: T) => void>,
    callback: (value: T) => void,
  ): (value: T) => void {
    let wrapped = cache.get(callback);
    if (!wrapped) {
      wrapped = (value) => {
        try { callback(value); } catch { /* Keep other consumers and the watchdog active. */ }
      };
      cache.set(callback, wrapped);
    }
    return wrapped;
  }

  constructor(options: {
    create: () => StreamSource;
    setTimer?: (callback: () => void, ms: number) => Timer;
    clearTimer?: (timer: Timer) => void;
    timeoutMs?: number;
  }) {
    this.options = options;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  observe(callback: (state: ConnectionState) => void): () => void {
    // OpenAI-Codex_engine_cli: an observer failure must not block stream state.
    callback = this.protect(this.safeStates, callback);
    this.observers.add(callback);
    callback(this.state);
    return () => { this.observers.delete(callback); };
  }

  subscribe(callback: (event: EventObject) => void): () => void {
    // OpenAI-Codex_engine_cli: isolate each event listener.
    callback = this.protect(this.safeEvents, callback);
    this.listeners.add(callback);
    if (!this.source) this.connect(true);
    return () => {
      this.listeners.delete(callback);
      if (!this.listeners.size) {
        this.closeSource();
        this.setState("disconnected");
      }
    };
  }

  retry(): void {
    this.closeSource();
    if (this.listeners.size) this.connect(true);
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.observers.forEach((callback) => callback(state));
  }

  private closeSource(): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    const source = this.source;
    this.source = null;
    source?.close();
  }

  private armWatchdog(source: StreamSource): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      if (this.source !== source) return;
      this.closeSource();
      this.setState("disconnected");
      if (this.listeners.size) this.connect(false);
    }, this.options.timeoutMs ?? 45000);
  }

  private connect(showConnecting: boolean): void {
    if (showConnecting) this.setState("connecting");
    let source: StreamSource;
    try { source = this.options.create(); }
    catch { this.setState("disconnected"); return; }
    this.source = source;
    source.onopen = () => {
      if (this.source !== source) return;
      this.setState("open");
      this.armWatchdog(source);
    };
    source.onerror = () => {
      if (this.source !== source) return;
      if (this.timer !== undefined) this.clearTimer(this.timer);
      this.timer = undefined;
      this.setState("disconnected");
    };
    source.onmessage = (message) => {
      if (this.source !== source || this.state !== "open") return;
      this.armWatchdog(source);
      try {
        const event: unknown = JSON.parse(message.data);
        if (!event || typeof event !== "object" || typeof (event as EventObject).type !== "string") return;
        if ((event as EventObject).type !== "heartbeat") this.listeners.forEach((callback) => callback(event as EventObject));
      } catch { /* Ignore malformed events. */ }
    };
    this.armWatchdog(source);
  }
}
