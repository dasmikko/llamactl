/**
 * Shared type contract for bunstash. Every module imports from here so the
 * CLI, daemon, supervisor, and proxy agree on data shapes. Keep this stable;
 * it is the seam that lets the pieces be built independently.
 */

/** Where a discovered model file came from. */
export type ModelSource =
  | "huggingface"
  | "ollama"
  | "lmstudio"
  | "config"
  | "path";

/** A `.gguf` model discovered on disk (Phase 2). */
export interface Model {
  /** Canonical, stable id derived from the file (slug). */
  id: string;
  /** Human-friendly display name. */
  name: string;
  /** Absolute path to the `.gguf` file. */
  path: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** Quantization label parsed from the filename, e.g. "Q4_K_M", or null. */
  quant: string | null;
  /** Which cache/source this was found in. */
  source: ModelSource;
  /** File mtime as epoch ms (used for "newest" tie-breaks and watch). */
  mtimeMs: number;
}

/** Status of a supervised llama-server child (Phase 4). */
export type RunningStatus = "starting" | "ready" | "crashed" | "stopping";

/** A running (or starting) llama-server child tracked by the daemon. */
export interface RunningModel {
  modelId: string;
  name: string;
  path: string;
  pid: number;
  /** Loopback port the child's HTTP server listens on. */
  port: number;
  status: RunningStatus;
  /** Epoch ms when the child was (last) spawned. */
  startedAt: number;
  /** Number of automatic restarts so far. */
  restarts: number;
  /** Absolute path to this launch's log file. */
  logPath: string;
}

/** Fully-resolved runtime configuration (defaults → file → env → flags). */
export interface Config {
  /** Extra directories to scan for `.gguf` files, beyond the known caches. */
  modelPaths: string[];
  /** Control-plane port to try first; scans upward if taken. */
  controlPort: number;
  /** Proxy listener config. host stays loopback unless explicitly opted in. */
  proxy: {
    host: string;
    port: number;
  };
  /** Explicit path to the `llama-server` binary, or null to use PATH. */
  llamaServerPath: string | null;
  /** Default context size passed as `--ctx-size`. */
  defaultCtx: number;
  /** Ollama-compat mode: claim 11434, answer "Ollama is running", etc. */
  ollamaCompat: boolean;
  /** Whether the proxy may fall back to a ready peer when a launch fails. */
  fallbackEnabled: boolean;
  /** Extra args appended verbatim to every `llama-server` invocation. */
  llamaServerArgs: string[];
}

/** Contents of `runtime.json` — how the CLI finds and authenticates to the daemon. */
export interface Runtime {
  /** Control-plane base URL, e.g. "http://127.0.0.1:48134". */
  controlUrl: string;
  /** Proxy base URL, e.g. "http://127.0.0.1:11435". */
  proxyUrl: string;
  /** Bearer token (32 random bytes, hex). Rotated on every daemon start. */
  token: string;
  /** Daemon process PID (for liveness / stale-file detection). */
  pid: number;
  /** Epoch ms the daemon started. */
  startedAt: number;
}

/* -------------------------------------------------------------------------- */
/* Control-plane wire types (CLI <-> daemon over loopback HTTP).               */
/* -------------------------------------------------------------------------- */

/** Standard error envelope returned by control-plane and proxy routes. */
export interface ApiError {
  error: {
    /** Machine-readable, stable error code (see ErrorCode). */
    code: ErrorCode;
    /** Human-readable, actionable message. */
    message: string;
    /** Optional structured detail. */
    detail?: unknown;
  };
}

/** Stable, typed error codes. Errors must be actionable, never silent. */
export type ErrorCode =
  | "unauthorized"
  | "bad_request"
  | "not_found"
  | "model_not_found"
  | "ambiguous_model"
  | "already_running"
  | "not_running"
  | "launch_failed"
  | "restart_cap_exceeded"
  | "llama_server_missing"
  | "daemon_unreachable"
  | "internal";

/** POST /start request body. */
export interface StartRequest {
  /** Model selector: id, name, substring, or absolute path. */
  model: string;
  /** Optional context-size override. */
  ctx?: number;
}

/** POST /stop request body. */
export interface StopRequest {
  model: string;
}

/** GET /ps response — currently running models. */
export interface PsResponse {
  running: RunningModel[];
}

/** GET /models response — discovered models on disk. */
export interface ModelsResponse {
  models: Model[];
}

/** GET /health response (the one unauthenticated route). */
export interface HealthResponse {
  ok: true;
  pid: number;
  startedAt: number;
}

/* -------------------------------------------------------------------------- */
/* Service interfaces — frozen seams so modules can be built independently.    */
/* -------------------------------------------------------------------------- */

/** Resolves a user selector (id, name, substring, or path) to a Model. */
export interface ModelResolver {
  /** Throws BunstashError("model_not_found" | "ambiguous_model") on failure. */
  resolve(selector: string): Model;
  /** Current list of discovered models. */
  all(): Model[];
}

/**
 * Supervises llama-server child processes. The proxy depends ONLY on this
 * interface, never on the concrete class, so the two can be built in parallel.
 */
export interface ISupervisor {
  /** All currently tracked children (starting, ready, or stopping). */
  list(): RunningModel[];
  /** Look up a tracked child by canonical model id. */
  get(modelId: string): RunningModel | undefined;
  /**
   * Start a model (resolving the selector). Resolves once the child process is
   * spawned and registered (status "starting"). Throws BunstashError on
   * resolution / launch failure or if already running.
   */
  start(selector: string, ctx?: number): Promise<RunningModel>;
  /** Stop a running model. Throws BunstashError("not_running") if absent. */
  stop(selector: string): Promise<RunningModel>;
  /**
   * Ensure a model is running AND has passed its /health readiness check,
   * starting it if necessary. Used by the proxy for auto-start on first
   * request. Throws BunstashError on launch/readiness failure.
   */
  ensureReady(selector: string, ctx?: number): Promise<RunningModel>;
  /** Terminate every child cleanly (daemon shutdown). */
  shutdownAll(): Promise<void>;
}
