/**
 * Owns the daemon connection and the single polling loop that drives the TUI.
 * One interval fetches /ps + /stats (the fast-changing data); /models +
 * /instances are fetched once on mount and after mutations. All errors are
 * funneled into an `error` string — render never throws.
 *
 * Solid port: the reactive state lives in a `createStore` exposed as `state`
 * (read `daemon.state.models` etc. in a tracked scope); the actions are plain
 * closures (the body runs once, so no memoization is needed). What were React
 * refs are plain locals, and the connect/poll effect is onMount + onCleanup.
 */

import { createStore } from "solid-js/store";
import { onCleanup, onMount } from "solid-js";
import type {
  Config,
  Model,
  InstanceConfig,
  RunningModel,
  StatsSnapshot,
  LlamaServerInfo,
  LlamaServerSpec,
  LlamaFlagsResponse,
  LaunchSpec,
  StartRequest,
  ModelsResponse,
  PsResponse,
  InstancesResponse,
  FavoritesResponse,
  StatsResponse,
  Download,
  DownloadsResponse,
  HfRepo,
  HfFile,
  HfSearchResponse,
  HfFilesResponse,
  InstallsResponse,
  BuildRequest,
} from "../types.ts";
import {
  connectDaemon,
  isProcessAlive,
  type DaemonConnection,
} from "../daemon/client.ts";
import { isLlamactlError } from "../errors.ts";

const POLL_MS = 1500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function errMessage(e: unknown): string {
  if (isLlamactlError(e)) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** The connected daemon's runtime facts (or null when disconnected). */
export type DaemonRuntime = { pid: number; controlUrl: string; startedAt: number } | null;

/** The reactive data bag exposed to the TUI as `daemon.state`. */
export interface DaemonState {
  models: Model[];
  instances: InstanceConfig[];
  /** Favorited row ids (starred models/profiles), floated to the top of the list. */
  favorites: string[];
  running: RunningModel[];
  stats: StatsSnapshot | null;
  /** The llama-server binary the daemon will spawn (path / found / version). */
  llamaServer: LlamaServerInfo | null;
  /** Flags the active llama-server binary accepts (parsed from --help); null until loaded. */
  llamaSpec: LlamaServerSpec | null;
  /** The connected daemon's runtime (PID, control URL, start time); null when disconnected. */
  daemon: DaemonRuntime;
  downloads: Download[];
  /** Managed llama.cpp installs, in-flight/recent builds, and the active install id. */
  installs: InstallsResponse | null;
  error: string | null;
  connected: boolean;
  /** True until the first connect attempt has settled. */
  connecting: boolean;
}

export interface UseDaemon {
  /** Reactive state store; read fields inside a tracked scope (JSX / memo). */
  state: DaemonState;
  start(req: StartRequest): Promise<void>;
  stop(model: string): Promise<void>;
  createInstance(
    name: string | undefined,
    spec: LaunchSpec,
    id?: string,
  ): Promise<void>;
  updateInstance(
    id: string,
    patch: { name?: string; spec?: LaunchSpec },
  ): Promise<void>;
  removeInstance(id: string): Promise<void>;
  /** Toggle the starred/favorite state of a row by id. */
  toggleFavorite(id: string): Promise<void>;
  /** Delete a model's file(s) from disk. */
  deleteModel(id: string): Promise<void>;
  /** Search Hugging Face; returns repos directly (not stored in state). */
  searchHf(query: string): Promise<HfRepo[]>;
  /** List the GGUF files in a repo. */
  listHfFiles(repo: string): Promise<HfFile[]>;
  /** Start downloading a file (and any sibling shards) from a repo. */
  pull(repo: string, file: string): Promise<void>;
  /** Cancel an in-flight download. */
  cancelDownload(id: string): Promise<void>;
  /** Dismiss a download from the list (clears errored/finished entries). */
  dismissDownload(id: string): Promise<void>;
  /** Retry/resume an errored or canceled download from its partial file. */
  retryDownload(id: string): Promise<void>;
  /** Start building a managed llama.cpp install from source. */
  startBuild(req: BuildRequest): Promise<void>;
  /** Cancel an in-flight build. */
  cancelBuild(id: string): Promise<void>;
  /** Select the active install (null falls back to the PATH binary). */
  setActiveInstall(id: string | null): Promise<void>;
  /** Delete a managed install. */
  removeInstall(id: string): Promise<void>;
  /** Rename a managed install (display name only). */
  renameInstall(id: string, name: string): Promise<void>;
  /** Fetch the latest code for an install's ref and recompile it in place. */
  updateInstall(id: string): Promise<void>;
  /** Stop the running daemon and spawn a fresh one (e.g. to pick up new code). */
  restartDaemon(): Promise<void>;
  refreshNow(): Promise<void>;
}

export function useDaemon(config: Config): UseDaemon {
  // What were React refs are plain locals: the body runs once under Solid.
  let conn: DaemonConnection | null = null;
  let mounted = true;

  const [state, setState] = createStore<DaemonState>({
    models: [],
    instances: [],
    favorites: [],
    running: [],
    stats: null,
    llamaServer: null,
    llamaSpec: null,
    daemon: null,
    downloads: [],
    installs: null,
    error: null,
    connected: false,
    connecting: true,
  });

  /** Fetch the rarely-changing lists (models + instances). */
  const refreshStatic = async (): Promise<void> => {
    if (!conn) return;
    try {
      const [m, inst, fav] = await Promise.all([
        conn.request<ModelsResponse>("GET", "/models"),
        conn.request<InstancesResponse>("GET", "/instances"),
        conn.request<FavoritesResponse>("GET", "/favorites"),
      ]);
      if (!mounted) return;
      setState({
        models: m.models,
        instances: inst.instances,
        favorites: fav.favorites,
      });
      // Best-effort and isolated: the flag spec is parsed once per binary and
      // re-fetched so switching the active install refreshes it, but an older
      // daemon without this route (or a probe failure) must NOT break the core
      // lists above. Leave llamaSpec untouched on failure.
      try {
        const flags = await conn.request<LlamaFlagsResponse>("GET", "/llama/flags");
        if (mounted) setState("llamaSpec", flags.spec);
      } catch {
        /* stale daemon / probe failure — the editor falls back to curated fields */
      }
    } catch (e) {
      if (mounted) setState("error", errMessage(e));
    }
  };

  /** Fetch the fast-changing data (running children + resource stats). */
  const refreshDynamic = async (): Promise<void> => {
    if (!conn) return;
    try {
      const [ps, st, dl, ins] = await Promise.all([
        conn.request<PsResponse>("GET", "/ps"),
        conn.request<StatsResponse>("GET", "/stats"),
        conn.request<DownloadsResponse>("GET", "/downloads"),
        conn.request<InstallsResponse>("GET", "/installs"),
      ]);
      if (!mounted) return;
      setState({
        running: ps.running,
        stats: st.stats,
        llamaServer: st.llamaServer,
        downloads: dl.downloads,
        installs: ins,
        error: null,
      });
      // While downloads are in flight or recently finished, keep the model list
      // fresh so a completed download shows up in the catalog promptly.
      if (dl.downloads.length > 0) void refreshStatic();
    } catch (e) {
      if (mounted) setState("error", errMessage(e));
    }
  };

  const refreshNow = async (): Promise<void> => {
    await Promise.all([refreshStatic(), refreshDynamic()]);
  };

  // Connect on mount, then poll the dynamic data on a single interval.
  onMount(() => {
    let interval: ReturnType<typeof setInterval> | null = null;

    void (async () => {
      try {
        const c = await connectDaemon({ config });
        if (!mounted) return;
        conn = c;
        setState({
          daemon: {
            pid: c.runtime.pid,
            controlUrl: c.runtime.controlUrl,
            startedAt: c.runtime.startedAt,
          },
          connected: true,
          connecting: false,
        });
        await refreshStatic();
        await refreshDynamic();
        interval = setInterval(() => {
          void refreshDynamic();
        }, POLL_MS);
      } catch (e) {
        if (!mounted) return;
        setState({ connected: false, connecting: false, error: errMessage(e) });
      }
    })();

    onCleanup(() => {
      mounted = false;
      if (interval) clearInterval(interval);
    });
  });

  const runMutation = async (
    fn: (conn: DaemonConnection) => Promise<unknown>,
  ): Promise<void> => {
    if (!conn) {
      setState("error", "not connected to the daemon");
      return;
    }
    try {
      await fn(conn);
      if (mounted) setState("error", null);
    } catch (e) {
      if (mounted) setState("error", errMessage(e));
    }
    await refreshNow();
  };

  const start = (req: StartRequest): Promise<void> =>
    runMutation((c) => c.request<RunningModel>("POST", "/start", req));

  const stop = (model: string): Promise<void> =>
    runMutation((c) => c.request<RunningModel>("POST", "/stop", { model }));

  const createInstance = (
    name: string | undefined,
    spec: LaunchSpec,
    id?: string,
  ): Promise<void> =>
    runMutation((c) =>
      c.request<InstanceConfig>("POST", "/instances", { id, name, spec }),
    );

  const updateInstance = (
    id: string,
    patch: { name?: string; spec?: LaunchSpec },
  ): Promise<void> =>
    runMutation((c) =>
      c.request<InstanceConfig>(
        "PUT",
        `/instances/${encodeURIComponent(id)}`,
        patch,
      ),
    );

  const removeInstance = (id: string): Promise<void> =>
    runMutation((c) =>
      c.request<{ ok: true }>("DELETE", `/instances/${encodeURIComponent(id)}`),
    );

  const toggleFavorite = (id: string): Promise<void> =>
    runMutation((c) =>
      c.request<FavoritesResponse>(
        "POST",
        `/favorites/${encodeURIComponent(id)}/toggle`,
      ),
    );

  const deleteModel = (id: string): Promise<void> =>
    runMutation((c) =>
      c.request<{ ok: true }>("DELETE", `/models/${encodeURIComponent(id)}`),
    );

  const restartDaemon = async (): Promise<void> => {
    const prev = conn;
    // Drop the connection so the polling loop pauses while the daemon is down,
    // and show the connecting state instead of the disconnected error screen.
    conn = null;
    setState({ connecting: true, connected: false });
    try {
      const pid = prev?.runtime.pid;
      if (pid !== undefined) {
        // SIGTERM mirrors `daemon stop`: the daemon clears runtime.json on the
        // way out, so connectDaemon below won't latch onto the dying process.
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Already gone; fall through to respawn.
        }
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && isProcessAlive(pid)) {
          await sleep(100);
        }
      }
      // connectDaemon forks a fresh daemon when no live runtime.json is present.
      const next = await connectDaemon({ config });
      if (!mounted) return;
      conn = next;
      setState({
        daemon: {
          pid: next.runtime.pid,
          controlUrl: next.runtime.controlUrl,
          startedAt: next.runtime.startedAt,
        },
        connected: true,
        connecting: false,
      });
      await refreshNow();
    } catch (e) {
      if (!mounted) return;
      setState({ connected: false, connecting: false, error: errMessage(e) });
    }
  };

  const searchHf = async (query: string): Promise<HfRepo[]> => {
    if (!conn) throw new Error("not connected to the daemon");
    const res = await conn.request<HfSearchResponse>(
      "GET",
      `/hf/search?q=${encodeURIComponent(query)}`,
    );
    return res.repos;
  };

  const listHfFiles = async (repo: string): Promise<HfFile[]> => {
    if (!conn) throw new Error("not connected to the daemon");
    const res = await conn.request<HfFilesResponse>(
      "GET",
      `/hf/files?repo=${encodeURIComponent(repo)}`,
    );
    return res.files;
  };

  const pull = (repo: string, file: string): Promise<void> =>
    runMutation((c) =>
      c.request<DownloadsResponse>("POST", "/pull", { repo, file }),
    );

  const cancelDownload = (id: string): Promise<void> =>
    runMutation((c) =>
      c.request<{ ok: true }>(
        "POST",
        `/downloads/${encodeURIComponent(id)}/cancel`,
      ),
    );

  const dismissDownload = (id: string): Promise<void> =>
    runMutation(async (c) =>
      setState(
        "downloads",
        (
          await c.request<DownloadsResponse>(
            "DELETE",
            `/downloads/${encodeURIComponent(id)}`,
          )
        ).downloads,
      ),
    );

  const retryDownload = (id: string): Promise<void> =>
    runMutation(async (c) =>
      setState(
        "downloads",
        (
          await c.request<DownloadsResponse>(
            "POST",
            `/downloads/${encodeURIComponent(id)}/retry`,
          )
        ).downloads,
      ),
    );

  const startBuild = (req: BuildRequest): Promise<void> =>
    runMutation(async (c) =>
      setState("installs", await c.request<InstallsResponse>("POST", "/installs", req)),
    );

  const cancelBuild = (id: string): Promise<void> =>
    runMutation(async (c) =>
      setState(
        "installs",
        await c.request<InstallsResponse>(
          "POST",
          `/installs/${encodeURIComponent(id)}/cancel`,
        ),
      ),
    );

  const setActiveInstall = (id: string | null): Promise<void> =>
    runMutation(async (c) =>
      setState(
        "installs",
        await c.request<InstallsResponse>("PUT", "/installs/active", { id }),
      ),
    );

  const removeInstall = (id: string): Promise<void> =>
    runMutation(async (c) =>
      setState(
        "installs",
        await c.request<InstallsResponse>(
          "DELETE",
          `/installs/${encodeURIComponent(id)}`,
        ),
      ),
    );

  const renameInstall = (id: string, name: string): Promise<void> =>
    runMutation(async (c) =>
      setState(
        "installs",
        await c.request<InstallsResponse>(
          "PATCH",
          `/installs/${encodeURIComponent(id)}`,
          { name },
        ),
      ),
    );

  const updateInstall = (id: string): Promise<void> =>
    runMutation(async (c) =>
      setState(
        "installs",
        await c.request<InstallsResponse>(
          "POST",
          `/installs/${encodeURIComponent(id)}/update`,
          {},
        ),
      ),
    );

  return {
    state,
    start,
    stop,
    createInstance,
    updateInstance,
    removeInstance,
    toggleFavorite,
    deleteModel,
    searchHf,
    listHfFiles,
    pull,
    cancelDownload,
    dismissDownload,
    retryDownload,
    startBuild,
    cancelBuild,
    setActiveInstall,
    removeInstall,
    renameInstall,
    updateInstall,
    restartDaemon,
    refreshNow,
  };
}
