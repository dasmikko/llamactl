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
  LaunchSpec,
  StartRequest,
  ModelsResponse,
  PsResponse,
  InstancesResponse,
  StatsResponse,
  Download,
  DownloadsResponse,
  HfRepo,
  HfFile,
  HfSearchResponse,
  HfFilesResponse,
} from "../types.ts";
import { connectDaemon, type DaemonConnection } from "../daemon/client.ts";
import { isLlamactlError } from "../errors.ts";

const POLL_MS = 1500;

function errMessage(e: unknown): string {
  if (isLlamactlError(e)) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

export interface UseDaemon {
  models: Model[];
  instances: InstanceConfig[];
  running: RunningModel[];
  stats: StatsSnapshot | null;
  downloads: Download[];
  error: string | null;
  connected: boolean;
  /** True until the first connect attempt has settled. */
  connecting: boolean;
  start(req: StartRequest): Promise<void>;
  stop(model: string): Promise<void>;
  createInstance(name: string | undefined, spec: LaunchSpec): Promise<void>;
  updateInstance(
    id: string,
    patch: { name?: string; spec?: LaunchSpec },
  ): Promise<void>;
  removeInstance(id: string): Promise<void>;
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
  refreshNow(): Promise<void>;
}

export function useDaemon(config: Config): UseDaemon {
  const connRef = useRef<DaemonConnection | null>(null);
  const mountedRef = useRef(true);

  const [models, setModels] = useState<Model[]>([]);
  const [instances, setInstances] = useState<InstanceConfig[]>([]);
  const [running, setRunning] = useState<RunningModel[]>([]);
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);

  /** Fetch the rarely-changing lists (models + instances). */
  const refreshStatic = useCallback(async (): Promise<void> => {
    const conn = connRef.current;
    if (!conn) return;
    try {
      const [m, inst] = await Promise.all([
        conn.request<ModelsResponse>("GET", "/models"),
        conn.request<InstancesResponse>("GET", "/instances"),
      ]);
      if (!mountedRef.current) return;
      setModels(m.models);
      setInstances(inst.instances);
    } catch (e) {
      if (mountedRef.current) setError(errMessage(e));
    }
  }, []);

  /** Fetch the fast-changing data (running children + resource stats). */
  const refreshDynamic = useCallback(async (): Promise<void> => {
    const conn = connRef.current;
    if (!conn) return;
    try {
      const [ps, st, dl] = await Promise.all([
        conn.request<PsResponse>("GET", "/ps"),
        conn.request<StatsResponse>("GET", "/stats"),
        conn.request<DownloadsResponse>("GET", "/downloads"),
      ]);
      if (!mountedRef.current) return;
      setRunning(ps.running);
      setStats(st.stats);
      setDownloads(dl.downloads);
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
    (name: string | undefined, spec: LaunchSpec) =>
      runMutation((conn) =>
        conn.request<InstanceConfig>("POST", "/instances", { name, spec }),
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

  const deleteModel = useCallback(
    (id: string) =>
      runMutation((conn) =>
        conn.request<{ ok: true }>("DELETE", `/models/${encodeURIComponent(id)}`),
      ),
    [runMutation],
  );

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

  return {
    models,
    instances,
    running,
    stats,
    downloads,
    error,
    connected,
    connecting,
    start,
    stop,
    createInstance,
    updateInstance,
    removeInstance,
    deleteModel,
    searchHf,
    listHfFiles,
    pull,
    cancelDownload,
    refreshNow,
  };
}
