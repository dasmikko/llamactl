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
  /** Transformer block count from GGUF metadata (for memory estimates), or null. */
  nLayers: number | null;
  /** Per-layer KV dimension (n_head_kv × head_dim) for KV-cache sizing, or null. */
  kvDim: number | null;
  /** Coarse kind inferred from metadata + filename. */
  kind: ModelKind;
  /** Author/org the model came from (e.g. "unsloth"), derived from the path, or null. */
  org: string | null;
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
  /** --n-cpu-moe: keep the first N layers' MoE expert weights on the CPU. */
  nCpuMoe?: number;
  /** --threads */
  threads?: number;
  /** --batch-size / -b */
  batchSize?: number;
  /** --ubatch-size / -ub: physical (micro) batch size. */
  ubatchSize?: number;
  /** --parallel / -np: number of parallel request slots the server serves. */
  parallel?: number;
  /** --alias / -a: model name reported to API clients (e.g. /v1/models). */
  alias?: string;
  /** --mmproj: multimodal projector file, required to run vision models. */
  mmproj?: string;
  /** --mlock: lock the model in RAM. "on" emits the flag; undefined ⇒ unset. */
  mlock?: "on" | "off";
  /** --no-mmap memory-mapping. "off" emits --no-mmap; undefined ⇒ default (on). */
  mmap?: "on" | "off";
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
  /** Version string of the `llama-server` binary, if it could be detected. */
  llamaServerVersion?: string;
}

/** Fully-resolved runtime configuration (defaults → file → env → flags). */
export interface Config {
  /** Extra directories to scan for `.gguf` files, beyond the known caches. */
  modelPaths: string[];
  /** Control-plane port to try first; scans upward if taken. */
  controlPort: number;
  /** Explicit path to the `llama-server` binary, or null to use PATH. */
  llamaServerPath: string | null;
  /**
   * Id of the active managed llama.cpp install whose binary the daemon spawns,
   * or null to fall back to `llamaServerPath`/PATH. `llamaServerPath` (when set)
   * still takes precedence as an explicit override.
   */
  activeInstall: string | null;
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
  /** Directory where Hugging Face downloads land (also scanned for models). */
  downloadDir: string;
  /** Hugging Face token for gated/private repos, or null to use the HF cache. */
  hfToken: string | null;
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
/* Hugging Face model fetching.                                                */
/* -------------------------------------------------------------------------- */

/** A Hugging Face repo from a search result. */
export interface HfRepo {
  /** "org/name". */
  id: string;
  likes: number;
  downloads: number;
  /** ISO timestamp of the last modification, or null. */
  updatedAt: string | null;
  /** Gated or private repo (needs a token). */
  gated: boolean;
}

/** A downloadable GGUF file within a repo. */
export interface HfFile {
  /** Path of the file within the repo. */
  rfilename: string;
  /** File size in bytes, or null if unknown. */
  sizeBytes: number | null;
  /** Quantization label parsed from the filename, or null. */
  quant: string | null;
}

/** Status of a model download. */
export type DownloadStatus = "downloading" | "done" | "error" | "canceled";

/** A tracked model download. */
export interface Download {
  /** Stable id for this download. */
  id: string;
  repo: string;
  /** rfilename being fetched. */
  file: string;
  /** Absolute destination path once complete. */
  destPath: string;
  receivedBytes: number;
  /** Total bytes from Content-Length, or null if the server didn't say. */
  totalBytes: number | null;
  status: DownloadStatus;
  /** Error message when status is "error". */
  error: string | null;
  startedAt: number;
}

/* -------------------------------------------------------------------------- */
/* Llama.cpp builds & managed installs.                                        */
/* -------------------------------------------------------------------------- */

/** Backend a llama.cpp build targets. */
export type LlamaBackend = "cpu" | "cuda";

/**
 * A built, managed llama.cpp installation. llamactl clones and builds these
 * itself into its own data dir; the registry only ever points at paths it owns.
 * One install is "active" at a time and supplies the `llama-server` binary the
 * supervisor spawns.
 */
export interface LlamaInstall {
  /** Stable slug, unique within the registry. */
  id: string;
  /** Human label shown in the UI. */
  name: string;
  /** Git repo the build was cloned from. */
  repo: string;
  /** Git ref (branch/tag/commit) requested. */
  ref: string;
  /** Resolved commit sha actually built, or null if unknown. */
  commit: string | null;
  /** Backend the build targeted. */
  backend: LlamaBackend;
  /** Absolute path to this install's `llama-server` binary. */
  binPath: string;
  /** Version reported by `llama-server --version`, or null. */
  version: string | null;
  /** Epoch ms when the build finished. */
  builtAt: number;
  /** Size on disk in bytes of the install dir, or null if unmeasured. */
  sizeBytes: number | null;
}

/** Status of a background llama.cpp build job. */
export type BuildStatus =
  | "queued"
  | "cloning"
  | "configuring"
  | "building"
  | "installing"
  | "ready"
  | "error"
  | "canceled";

/** A tracked llama.cpp build job (mirrors a Download for the UI/CLI). */
export interface BuildJob {
  /** Stable id for this build (also the resulting install id on success). */
  id: string;
  /** Human label, defaults to a slug derived from repo+ref. */
  name: string;
  repo: string;
  ref: string;
  backend: LlamaBackend;
  /** Pass `-allow-unsupported-compiler` to nvcc (CUDA builds with a too-new host gcc). */
  allowUnsupportedCompiler: boolean;
  /** Host C++ compiler nvcc should use (`-DCMAKE_CUDA_HOST_COMPILER`), or null. */
  cudaHostCompiler: string | null;
  status: BuildStatus;
  /** Tail of the build log (most recent lines) for live progress display. */
  logTail: string[];
  /**
   * Absolute path to this build's full log file on disk. Persisted so a failed
   * build's output survives the cleanup of its (partial) install dir and can be
   * opened in full. Removed when the job is cleared/removed.
   */
  logPath: string;
  /** Error message when status is "error". */
  error: string | null;
  /** Id of the resulting install once status is "ready" (equals `id`). */
  installId: string | null;
  startedAt: number;
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
  | "hf_error"
  | "download_not_found"
  | "build_failed"
  | "missing_toolchain"
  | "install_not_found"
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
  /** Explicit id to create under (used for a model's inline config). */
  id?: string;
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

/** GET /favorites response — the set of favorited row ids (model or instance ids). */
export interface FavoritesResponse {
  favorites: string[];
}

/** Availability + version of the `llama-server` binary the daemon will spawn. */
export interface LlamaServerInfo {
  /** Resolved path, or the bare command name the daemon will exec. */
  path: string;
  /** Whether that binary was found (at the configured path or on PATH). */
  found: boolean;
  /** Version reported by `--version`, when the binary is present and readable. */
  version?: string;
}

/** GET /stats response — latest resource snapshot + llama-server availability. */
export interface StatsResponse {
  stats: StatsSnapshot;
  llamaServer: LlamaServerInfo;
}

/** GET /hf/search response — matching repos. */
export interface HfSearchResponse {
  repos: HfRepo[];
}

/** GET /hf/files response — GGUF files in a repo. */
export interface HfFilesResponse {
  files: HfFile[];
}

/** GET /downloads response — tracked downloads. */
export interface DownloadsResponse {
  downloads: Download[];
}

/** POST /pull request body. Downloads `file` (and any sibling shards) from `repo`. */
export interface PullRequest {
  repo: string;
  /** rfilename to fetch; if omitted the caller should resolve a default first. */
  file: string;
  /** Git revision; defaults to "main". */
  revision?: string;
}

/**
 * GET /installs response — managed builds, in-flight/recent build jobs, and the
 * id of the active install (null when falling back to the PATH binary).
 */
export interface InstallsResponse {
  installs: LlamaInstall[];
  builds: BuildJob[];
  activeId: string | null;
}

/** POST /installs request body — start a llama.cpp build from source. */
export interface BuildRequest {
  /** Git repo URL to clone. */
  repo: string;
  /** Git ref (branch/tag/commit); defaults to the repo's default branch. */
  ref?: string;
  /** Backend to target; defaults to "cuda". */
  backend?: LlamaBackend;
  /** Display name; defaults to a slug derived from repo+ref. */
  name?: string;
  /**
   * Pass `-allow-unsupported-compiler` to nvcc (CUDA builds only). Default false.
   * Set this when nvcc aborts with "unsupported GNU version" because the host
   * gcc is newer than the installed CUDA toolkit officially supports.
   */
  allowUnsupportedCompiler?: boolean;
  /**
   * Host C++ compiler for nvcc to use (CUDA builds only), e.g. "g++-15" or an
   * absolute path. Maps to `-DCMAKE_CUDA_HOST_COMPILER`. Use when the default
   * gcc is too new for the CUDA toolkit but an older, supported gcc is installed.
   */
  cudaHostCompiler?: string;
}

/** PUT /installs/active request body — select the active install. */
export interface ActiveInstallRequest {
  /** Install id to activate, or null to fall back to the PATH binary. */
  id: string | null;
}

/** PATCH /installs/:id request body — rename a managed install. */
export interface InstallRenameRequest {
  /** New display name (the install id is unchanged). */
  name: string;
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
   * Report the `llama-server` binary the daemon will spawn: its path, whether it
   * was found, and its version. Result is detected once and cached.
   */
  serverInfo(): Promise<LlamaServerInfo>;
  /**
   * Ensure a model is running AND has passed its /health readiness check,
   * starting it from the spec if necessary. Throws LlamactlError on
   * launch/readiness failure.
   */
  ensureReady(spec: LaunchSpec): Promise<RunningModel>;
  /** Terminate every child cleanly (daemon shutdown). */
  shutdownAll(): Promise<void>;
}

/** Manages background model downloads (owned by the daemon). */
export interface IDownloadManager {
  /** All tracked downloads (active and recently finished). */
  list(): Download[];
  get(id: string): Download | undefined;
  /**
   * Begin downloading `file` from `repo` in the background. Returns the tracked
   * Download immediately (status "downloading"). Idempotent per repo+file: a
   * download already in flight for the same target is returned as-is.
   */
  start(repo: string, file: string, revision?: string): Download;
  /** Cancel an in-flight download. Throws LlamactlError("download_not_found"). */
  cancel(id: string): void;
  /**
   * Remove a download from the list entirely (aborting it first if still in
   * flight) — used to clear errored/finished entries. Throws
   * LlamactlError("download_not_found") for an unknown id.
   */
  dismiss(id: string): void;
  /**
   * Re-queue an errored or canceled download, resuming from its partial `.part`
   * file. No-op if it is already downloading or done. Throws
   * LlamactlError("download_not_found") for an unknown id.
   */
  retry(id: string): Download;
}

/**
 * Manages llama.cpp builds and the registry of managed installs (owned by the
 * daemon). Builds run in the background; the active install supplies the
 * `llama-server` binary the supervisor spawns. Callers depend only on this seam.
 */
export interface IInstallManager {
  /** All managed installs. */
  installs(): LlamaInstall[];
  /** All tracked build jobs (active and recently finished). */
  builds(): BuildJob[];
  /** The active install, or null when falling back to the PATH binary. */
  getActive(): LlamaInstall | null;
  /**
   * Begin a llama.cpp build in the background. Returns the tracked BuildJob
   * immediately (status "queued"/"cloning"). The job's id becomes the install id.
   */
  start(req: BuildRequest): BuildJob;
  /** Cancel an in-flight build. Throws LlamactlError("install_not_found"). */
  cancel(id: string): void;
  /**
   * Rename a managed install (display name only; the id is unchanged). Throws
   * LlamactlError("install_not_found") for an unknown id, or
   * LlamactlError("bad_request") for an empty name.
   */
  rename(id: string, name: string): Promise<void>;
  /**
   * Set the active install (or null to fall back to PATH). Persists the choice.
   * Throws LlamactlError("install_not_found") for an unknown id.
   */
  setActive(id: string | null): Promise<void>;
  /**
   * Remove an install and delete its files. Throws
   * LlamactlError("install_not_found") for an unknown id.
   */
  remove(id: string): Promise<void>;
}

/** Persisted CRUD over saved instance profiles (owned by the daemon). */
export interface InstanceStore {
  list(): InstanceConfig[];
  get(id: string): InstanceConfig | undefined;
  /**
   * Create a profile; throws LlamactlError("instance_exists") on id collision.
   * An explicit `id` is used verbatim (used for a model's inline config, whose
   * id must equal the model id); otherwise the id is derived from name/model.
   */
  create(input: { id?: string; name?: string; spec: LaunchSpec }): Promise<InstanceConfig>;
  /** Update a profile; throws LlamactlError("instance_not_found"). */
  update(id: string, patch: { name?: string; spec?: LaunchSpec }): Promise<InstanceConfig>;
  /** Remove a profile; throws LlamactlError("instance_not_found"). */
  remove(id: string): Promise<void>;
}

/**
 * Persisted set of "favorited" rows, keyed by the row's id (a discovered
 * model id, or an instance id for profile-only rows). Favorites float to the
 * top of the list and are marked with a star in the TUI. Owned by the daemon.
 */
export interface FavoriteStore {
  /** All favorited ids. */
  list(): string[];
  /** Whether `id` is favorited. */
  has(id: string): boolean;
  /** Flip `id`'s favorite state; returns the new state (true = now favorited). */
  toggle(id: string): Promise<boolean>;
}
