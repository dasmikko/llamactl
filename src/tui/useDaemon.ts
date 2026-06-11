/**
 * React hook owning the daemon connection and the single polling loop that
 * drives the TUI. One setInterval fetches /ps + /stats (the fast-changing
 * data); /models + /instances are fetched once on mount and after mutations.
 * All errors are funneled into an `error` string — render never throws.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Config,
  Model,
  InstanceConfig,
  RunningModel,
  StatsSnapshot,
  LlamaServerInfo,
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

export interface UseDaemon {
  models: Model[];
  instances: InstanceConfig[];
  /** Favorited row ids (starred models/profiles), floated to the top of the list. */
  favorites: string[];
  running: RunningModel[];
  stats: StatsSnapshot | null;
  /** The llama-server binary the daemon will spawn (path / found / version). */
  llamaServer: LlamaServerInfo | null;
  downloads: Download[];
  /** Managed llama.cpp installs, in-flight/recent builds, and the active install id. */
  installs: InstallsResponse | null;
  error: string | null;
  connected: boolean;
  /** True until the first connect attempt has settled. */
  connecting: boolean;
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
  const connRef = useRef<DaemonConnection | null>(null);
  const mountedRef = useRef(true);

  const [models, setModels] = useState<Model[]>([]);
  const [instances, setInstances] = useState<InstanceConfig[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [running, setRunning] = useState<RunningModel[]>([]);
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [llamaServer, setLlamaServer] = useState<LlamaServerInfo | null>(null);
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [installs, setInstalls] = useState<InstallsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);

  /** Fetch the rarely-changing lists (models + instances). */
  const refreshStatic = useCallback(async (): Promise<void> => {
    const conn = connRef.current;
    if (!conn) return;
    try {
      const [m, inst, fav] = await Promise.all([
        conn.request<ModelsResponse>("GET", "/models"),
        conn.request<InstancesResponse>("GET", "/instances"),
        conn.request<FavoritesResponse>("GET", "/favorites"),
      ]);
      if (!mountedRef.current) return;
      setModels(m.models);
      setInstances(inst.instances);
      setFavorites(fav.favorites);
    } catch (e) {
      if (mountedRef.current) setError(errMessage(e));
    }
  }, []);

  /** Fetch the fast-changing data (running children + resource stats). */
  const refreshDynamic = useCallback(async (): Promise<void> => {
    const conn = connRef.current;
    if (!conn) return;
    try {
      const [ps, st, dl, ins] = await Promise.all([
        conn.request<PsResponse>("GET", "/ps"),
        conn.request<StatsResponse>("GET", "/stats"),
        conn.request<DownloadsResponse>("GET", "/downloads"),
        conn.request<InstallsResponse>("GET", "/installs"),
      ]);
      if (!mountedRef.current) return;
      setRunning(ps.running);
      setStats(st.stats);
      setLlamaServer(st.llamaServer);
      setDownloads(dl.downloads);
      setInstalls(ins);
      setError(null);
      // While downloads are in flight or recently finished, keep the model list
      // fresh so a completed download shows up in the catalog promptly.
      if (dl.downloads.length > 0) void refreshStatic();
    } catch (e) {
      if (mountedRef.current) setError(errMessage(e));
    }
  }, [refreshStatic]);

  const refreshNow = useCallback(async (): Promise<void> => {
    await Promise.all([refreshStatic(), refreshDynamic()]);
  }, [refreshStatic, refreshDynamic]);

  // Connect on mount, then poll the dynamic data on a single interval.
  useEffect(() => {
    mountedRef.current = true;
    let interval: ReturnType<typeof setInterval> | null = null;

    (async () => {
      try {
        const conn = await connectDaemon({ config });
        if (!mountedRef.current) return;
        connRef.current = conn;
        setConnected(true);
        setConnecting(false);
        await refreshStatic();
        await refreshDynamic();
        interval = setInterval(() => {
          void refreshDynamic();
        }, POLL_MS);
      } catch (e) {
        if (!mountedRef.current) return;
        setConnected(false);
        setConnecting(false);
        setError(errMessage(e));
      }
    })();

    return () => {
      mountedRef.current = false;
      if (interval) clearInterval(interval);
    };
  }, [config, refreshStatic, refreshDynamic]);

  const runMutation = useCallback(
    async (fn: (conn: DaemonConnection) => Promise<unknown>): Promise<void> => {
      const conn = connRef.current;
      if (!conn) {
        setError("not connected to the daemon");
        return;
      }
      try {
        await fn(conn);
        if (mountedRef.current) setError(null);
      } catch (e) {
        if (mountedRef.current) setError(errMessage(e));
      }
      await refreshNow();
    },
    [refreshNow],
  );

  const start = useCallback(
    (req: StartRequest) =>
      runMutation((conn) => conn.request<RunningModel>("POST", "/start", req)),
    [runMutation],
  );

  const stop = useCallback(
    (model: string) =>
      runMutation((conn) =>
        conn.request<RunningModel>("POST", "/stop", { model }),
      ),
    [runMutation],
  );

  const createInstance = useCallback(
    (name: string | undefined, spec: LaunchSpec, id?: string) =>
      runMutation((conn) =>
        conn.request<InstanceConfig>("POST", "/instances", { id, name, spec }),
      ),
    [runMutation],
  );

  const updateInstance = useCallback(
    (id: string, patch: { name?: string; spec?: LaunchSpec }) =>
      runMutation((conn) =>
        conn.request<InstanceConfig>(
          "PUT",
          `/instances/${encodeURIComponent(id)}`,
          patch,
        ),
      ),
    [runMutation],
  );

  const removeInstance = useCallback(
    (id: string) =>
      runMutation((conn) =>
        conn.request<{ ok: true }>(
          "DELETE",
          `/instances/${encodeURIComponent(id)}`,
        ),
      ),
    [runMutation],
  );

  const toggleFavorite = useCallback(
    (id: string) =>
      runMutation((conn) =>
        conn.request<FavoritesResponse>(
          "POST",
          `/favorites/${encodeURIComponent(id)}/toggle`,
        ),
      ),
    [runMutation],
  );

  const deleteModel = useCallback(
    (id: string) =>
      runMutation((conn) =>
        conn.request<{ ok: true }>("DELETE", `/models/${encodeURIComponent(id)}`),
      ),
    [runMutation],
  );

  const restartDaemon = useCallback(async (): Promise<void> => {
    const conn = connRef.current;
    // Drop the connection so the polling loop pauses while the daemon is down,
    // and show the connecting state instead of the disconnected error screen.
    connRef.current = null;
    setConnecting(true);
    setConnected(false);
    try {
      const pid = conn?.runtime.pid;
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
      if (!mountedRef.current) return;
      connRef.current = next;
      setConnected(true);
      setConnecting(false);
      await refreshNow();
    } catch (e) {
      if (!mountedRef.current) return;
      setConnected(false);
      setConnecting(false);
      setError(errMessage(e));
    }
  }, [config, refreshNow]);

  const searchHf = useCallback(async (query: string): Promise<HfRepo[]> => {
    const conn = connRef.current;
    if (!conn) throw new Error("not connected to the daemon");
    const res = await conn.request<HfSearchResponse>(
      "GET",
      `/hf/search?q=${encodeURIComponent(query)}`,
    );
    return res.repos;
  }, []);

  const listHfFiles = useCallback(async (repo: string): Promise<HfFile[]> => {
    const conn = connRef.current;
    if (!conn) throw new Error("not connected to the daemon");
    const res = await conn.request<HfFilesResponse>(
      "GET",
      `/hf/files?repo=${encodeURIComponent(repo)}`,
    );
    return res.files;
  }, []);

  const pull = useCallback(
    (repo: string, file: string) =>
      runMutation((conn) =>
        conn.request<DownloadsResponse>("POST", "/pull", { repo, file }),
      ),
    [runMutation],
  );

  const cancelDownload = useCallback(
    (id: string) =>
      runMutation((conn) =>
        conn.request<{ ok: true }>(
          "POST",
          `/downloads/${encodeURIComponent(id)}/cancel`,
        ),
      ),
    [runMutation],
  );

  const dismissDownload = useCallback(
    (id: string) =>
      runMutation(async (conn) =>
        setDownloads(
          (await conn.request<DownloadsResponse>(
            "DELETE",
            `/downloads/${encodeURIComponent(id)}`,
          )).downloads,
        ),
      ),
    [runMutation],
  );

  const retryDownload = useCallback(
    (id: string) =>
      runMutation(async (conn) =>
        setDownloads(
          (await conn.request<DownloadsResponse>(
            "POST",
            `/downloads/${encodeURIComponent(id)}/retry`,
          )).downloads,
        ),
      ),
    [runMutation],
  );

  const startBuild = useCallback(
    (req: BuildRequest) =>
      runMutation(async (conn) =>
        setInstalls(await conn.request<InstallsResponse>("POST", "/installs", req)),
      ),
    [runMutation],
  );

  const cancelBuild = useCallback(
    (id: string) =>
      runMutation(async (conn) =>
        setInstalls(
          await conn.request<InstallsResponse>(
            "POST",
            `/installs/${encodeURIComponent(id)}/cancel`,
          ),
        ),
      ),
    [runMutation],
  );

  const setActiveInstall = useCallback(
    (id: string | null) =>
      runMutation(async (conn) =>
        setInstalls(
          await conn.request<InstallsResponse>("PUT", "/installs/active", { id }),
        ),
      ),
    [runMutation],
  );

  const removeInstall = useCallback(
    (id: string) =>
      runMutation(async (conn) =>
        setInstalls(
          await conn.request<InstallsResponse>(
            "DELETE",
            `/installs/${encodeURIComponent(id)}`,
          ),
        ),
      ),
    [runMutation],
  );

  const renameInstall = useCallback(
    (id: string, name: string) =>
      runMutation(async (conn) =>
        setInstalls(
          await conn.request<InstallsResponse>(
            "PATCH",
            `/installs/${encodeURIComponent(id)}`,
            { name },
          ),
        ),
      ),
    [runMutation],
  );

  const updateInstall = useCallback(
    (id: string) =>
      runMutation(async (conn) =>
        setInstalls(
          await conn.request<InstallsResponse>(
            "POST",
            `/installs/${encodeURIComponent(id)}/update`,
            {},
          ),
        ),
      ),
    [runMutation],
  );

  return {
    models,
    instances,
    favorites,
    running,
    stats,
    llamaServer,
    downloads,
    installs,
    error,
    connected,
    connecting,
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
