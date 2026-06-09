/**
 * Shared type contract for llamactl. Every module imports from here so the
 * CLI, daemon, supervisor, monitor, and TUI agree on data shapes. Keep this
 * stable; it is the seam that lets the pieces be built independently.
 */

/** Where a discovered model file came from. */
export type ModelSource =
  | "huggingface"
  | "ollama"
  | "lmstudio"
  | "config"
  | "path";

/** Coarse model kind inferred from GGUF metadata + filename. */
export type ModelKind = "text" | "vision" | "embedding";

/** A `.gguf` model discovered on disk. */
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
  /** GGUF architecture (e.g. "llama", "qwen2", "gemma2"), or null if unread. */
  arch: string | null;
  /** Supported/trained context length from GGUF metadata, or null. */
  contextLength: number | null;
  /** Coarse kind inferred from metadata + filename. */
  kind: ModelKind;
}

/* -------------------------------------------------------------------------- */
/* Launch specs & saved instance profiles.                                     */
/* -------------------------------------------------------------------------- */

/**
 * Structured llama-server launch parameters. All optional except `model`;
 * absent structured fields fall back to config defaults at spawn time. The
 * `extraArgs` escape hatch carries any flag not modelled here.
 */
export interface LaunchSpec {
  /** Model selector (id, name, substring, or absolute path). Required. */
  model: string;
  /** --ctx-size */
  ctxSize?: number;
  /** --gpu-layers / -ngl (0 = CPU only). */
  gpuLayers?: number;
  /** --threads */
  threads?: number;
  /** --batch-size / -b */
  batchSize?: number;
  /** --flash-attn on|off; undefined ⇒ leave unset (llama.cpp default: auto). */
  flashAttn?: "on" | "off";
  /** --reasoning on|off; undefined ⇒ leave unset (default: auto, detect from template). */
  reasoning?: "on" | "off";
  /** --jinja / --no-jinja chat-template engine; undefined ⇒ leave unset (default: enabled). */
  jinja?: "on" | "off";
  /** --chat-template: a built-in template name or a Jinja string. */
  chatTemplate?: string;
  /** --cache-type-k: KV-cache quant for K (e.g. "f16", "q8_0"). Undefined ⇒ default. */
  cacheTypeK?: string;
  /** --cache-type-v: KV-cache quant for V (e.g. "f16", "q8_0"). Undefined ⇒ default. */
  cacheTypeV?: string;
  /** --host (default 127.0.0.1; non-loopback is an explicit opt-in). */
  host?: string;
  /** Fixed --port, or undefined ("auto") to let the supervisor assign one. */
  port?: number;
  /** Freeform args appended verbatim after the structured ones. */
  extraArgs?: string[];
}

/** A persisted, named launch profile the user manages in the TUI/CLI. */
export interface InstanceConfig {
  /** Stable slug, unique within the store. */
  id: string;
  /** Human label shown in the UI. Defaults to id. */
  name: string;
  /** The launch spec this profile applies. */
  spec: LaunchSpec;
  /** Epoch ms when created. */
  createdAt: number;
  /** Epoch ms of the last update. */
  updatedAt: number;
}

/** Status of a supervised llama-server child. */
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
  /** The resolved spec the child was launched with (for display/edit). */
  spec: LaunchSpec;
}

/** Fully-resolved runtime configuration (defaults → file → env → flags). */
export interface Config {
  /** Extra directories to scan for `.gguf` files, beyond the known caches. */
  modelPaths: string[];
  /** Control-plane port to try first; scans upward if taken. */
  controlPort: number;
  /** Explicit path to the `llama-server` binary, or null to use PATH. */
  llamaServerPath: string | null;
  /** Default context size passed as `--ctx-size` when a spec omits it. */
  defaultCtx: number;
  /**
   * Default `--gpu-layers` when a spec omits it. Defaults to 99 (offload all
   * layers to the GPU); set to 0 for CPU-only, or lower for models too big to
   * fully fit in VRAM.
   */
  defaultGpuLayers: number;
  /** Extra args appended verbatim to every `llama-server` invocation. */
  llamaServerArgs: string[];
}

/** Contents of `runtime.json` — how the CLI finds and authenticates to the daemon. */
export interface Runtime {
  /** Control-plane base URL, e.g. "http://127.0.0.1:48134". */
  controlUrl: string;
  /** Bearer token (32 random bytes, hex). Rotated on every daemon start. */
  token: string;
  /** Daemon process PID (for liveness / stale-file detection). */
  pid: number;
  /** Epoch ms the daemon started. */
  startedAt: number;
}

/* -------------------------------------------------------------------------- */
/* Resource monitoring.                                                        */
/* -------------------------------------------------------------------------- */

/** System-wide CPU and memory usage. */
export interface SystemStats {
  /** Total CPU utilization across all cores, 0..100. */
  cpuPct: number;
  /** Used memory in bytes (total - available). */
  memUsed: number;
  /** Total memory in bytes. */
  memTotal: number;
  /** CPU package temperature in °C, or null if unavailable. */
  tempC: number | null;
}

/** Per-GPU utilization and VRAM, from nvidia-smi. */
export interface GpuStats {
  index: number;
  name: string;
  /** GPU utilization, 0..100. */
  utilPct: number;
  /** VRAM used in bytes. */
  vramUsed: number;
  /** VRAM total in bytes. */
  vramTotal: number;
  /** GPU temperature in °C, or null if unavailable. */
  tempC: number | null;
}

/** Per-instance resource usage, joined to a running child by pid. */
export interface InstanceStats {
  modelId: string;
  pid: number;
  /** CPU as percent of one core (can exceed 100 on multicore). */
  cpuPct: number;
  /** Resident set size in bytes. */
  rssBytes: number;
  /** VRAM attributed to this pid in bytes; 0 if unknown / no nvidia-smi. */
  vramBytes: number;
}

/** A single resource-monitoring sample. */
export interface StatsSnapshot {
  /** Epoch ms the snapshot was taken. */
  ts: number;
  system: SystemStats;
  /** Empty when nvidia-smi is unavailable. */
  gpus: GpuStats[];
  instances: InstanceStats[];
  /** False => TUI hides GPU/VRAM columns and header. */
  gpuAvailable: boolean;
}

/* -------------------------------------------------------------------------- */
/* Control-plane wire types (CLI/TUI <-> daemon over loopback HTTP).            */
/* -------------------------------------------------------------------------- */

/** Standard error envelope returned by control-plane routes. */
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
  | "instance_not_found"
  | "instance_exists"
  | "invalid_spec"
  | "internal";

/**
 * POST /start request body. Accepts EITHER a saved instance id, an inline
 * spec, or the legacy `{ model, ctx }` selector form (translated to a spec).
 */
export interface StartRequest {
  /** Legacy/back-compat: model selector only. */
  model?: string;
  /** Legacy: context-size override paired with `model`. */
  ctx?: number;
  /** Start a saved profile by id. */
  instance?: string;
  /** Start an inline spec. */
  spec?: LaunchSpec;
}

/** POST /stop request body. */
export interface StopRequest {
  model: string;
}

/** Body for creating/updating a saved instance profile. */
export interface InstanceUpsertRequest {
  name?: string;
  spec: LaunchSpec;
}

/** GET /ps response — currently running models. */
export interface PsResponse {
  running: RunningModel[];
}

/** GET /models response — discovered models on disk. */
export interface ModelsResponse {
  models: Model[];
}

/** GET /instances response — saved profiles. */
export interface InstancesResponse {
  instances: InstanceConfig[];
}

/** GET /stats response — latest resource snapshot. */
export interface StatsResponse {
  stats: StatsSnapshot;
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
  /** Throws LlamactlError("model_not_found" | "ambiguous_model") on failure. */
  resolve(selector: string): Model;
  /** Current list of discovered models. */
  all(): Model[];
}

/**
 * Supervises llama-server child processes. Callers depend ONLY on this
 * interface, never on the concrete class, so pieces can be built in parallel.
 */
export interface ISupervisor {
  /** All currently tracked children (starting, ready, or stopping). */
  list(): RunningModel[];
  /** Look up a tracked child by canonical model id. */
  get(modelId: string): RunningModel | undefined;
  /**
   * Start a model from a launch spec (resolving `spec.model`). Resolves once
   * the child process is spawned and registered (status "starting"). Throws
   * LlamactlError on resolution / launch failure or if already running.
   */
  start(spec: LaunchSpec): Promise<RunningModel>;
  /** Stop a running model. Throws LlamactlError("not_running") if absent. */
  stop(selector: string): Promise<RunningModel>;
  /**
   * Ensure a model is running AND has passed its /health readiness check,
   * starting it from the spec if necessary. Throws LlamactlError on
   * launch/readiness failure.
   */
  ensureReady(spec: LaunchSpec): Promise<RunningModel>;
  /** Terminate every child cleanly (daemon shutdown). */
  shutdownAll(): Promise<void>;
}

/** Persisted CRUD over saved instance profiles (owned by the daemon). */
export interface InstanceStore {
  list(): InstanceConfig[];
  get(id: string): InstanceConfig | undefined;
  /** Create a profile; throws LlamactlError("instance_exists") on id collision. */
  create(input: { name?: string; spec: LaunchSpec }): Promise<InstanceConfig>;
  /** Update a profile; throws LlamactlError("instance_not_found"). */
  update(id: string, patch: { name?: string; spec?: LaunchSpec }): Promise<InstanceConfig>;
  /** Remove a profile; throws LlamactlError("instance_not_found"). */
  remove(id: string): Promise<void>;
}
