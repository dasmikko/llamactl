/**
 * The control plane: a loopback-only HTTP listener the CLI and TUI use to drive
 * the daemon. Every route except `GET /health` requires the bearer token,
 * compared in constant time. It is hard-wired to 127.0.0.1 — it must never be
 * bindable off-loopback.
 */

import type {
  ActiveInstallRequest,
  BuildRequest,
  InstallRenameRequest,
  InstallUpdateRequest,
  Download,
  DownloadsResponse,
  FavoriteStore,
  FavoritesResponse,
  HealthResponse,
  HfFilesResponse,
  HfSearchResponse,
  IDownloadManager,
  IInstallManager,
  InstallsResponse,
  InstanceStore,
  InstanceUpsertRequest,
  InstancesResponse,
  ISupervisor,
  LaunchSpec,
  LlamaFlagsResponse,
  Model,
  ModelsResponse,
  PsResponse,
  PullRequest,
  StartRequest,
  StatsResponse,
  StatsSnapshot,
  StopRequest,
} from "../types.ts";
import { LlamactlError, toLlamactlError } from "../errors.ts";
import { findFreePort } from "../net/ports.ts";
import { searchModels, listGgufFiles } from "../hf/client.ts";
import { deleteModelFiles, runnableModels } from "../discovery/models.ts";
import { constantTimeEqual } from "./runtime.ts";

/** The slice of the resource sampler the control plane needs. */
export interface StatsSource {
  snapshot(): StatsSnapshot;
}

export interface ControlPlaneOptions {
  token: string;
  supervisor: ISupervisor;
  /** Saved instance profiles (CRUD). */
  instances: InstanceStore;
  /** Favorited row ids (starred models/profiles). */
  favorites: FavoriteStore;
  /** Source of the latest resource snapshot. */
  sampler: StatsSource;
  /** Background Hugging Face downloads. */
  downloads: IDownloadManager;
  /** Managed llama.cpp builds and installs. */
  installs: IInstallManager;
  /** Resolve the Hugging Face token (config or HF cache) for API calls. */
  getHfToken: () => Promise<string | null>;
  /** Returns the current set of discovered models. */
  models: () => Model[];
  /** Re-run model discovery (e.g. after a model file is deleted). */
  refreshModels: () => void;
  /** First control-plane port to try; scans upward if taken. */
  startPort: number;
  pid: number;
  startedAt: number;
  /** Invoked when a client requests graceful shutdown via POST /shutdown. */
  onShutdown: () => void;
}

export interface ControlPlaneHandle {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  port: number;
  stop: () => void;
}

const LOOPBACK = "127.0.0.1";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(e: unknown): Response {
  const err = toLlamactlError(e);
  return json(err.toApiError(), err.httpStatus);
}

/** Extract a bearer token from the Authorization header, or null. */
function bearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1]! : null;
}

/**
 * Resolve a POST /start body into a concrete LaunchSpec. Accepts a saved
 * instance id, an inline spec, or the legacy `{ model, ctx }` selector form.
 */
function resolveStartSpec(body: StartRequest, instances: InstanceStore): LaunchSpec {
  if (body.instance !== undefined) {
    const profile = instances.get(body.instance);
    if (!profile) {
      throw new LlamactlError("instance_not_found", `no saved instance "${body.instance}"`, {
        detail: { instance: body.instance },
      });
    }
    return profile.spec;
  }
  if (body.spec !== undefined) {
    if (typeof body.spec.model !== "string" || body.spec.model.length === 0) {
      throw new LlamactlError("bad_request", "spec.model is required");
    }
    return body.spec;
  }
  if (typeof body.model === "string" && body.model.length > 0) {
    return { model: body.model, ctxSize: body.ctx };
  }
  throw new LlamactlError("bad_request", "provide one of: instance, spec, or model");
}

const SHARD_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i;

/**
 * Given a chosen file and the repo's full GGUF file list, return every file
 * that must be downloaded together: the whole shard group for a sharded model,
 * otherwise just the single file.
 */
function shardGroup(file: string, allFiles: string[]): string[] {
  const m = SHARD_RE.exec(file);
  if (!m) return [file];
  const [, prefix, , total] = m;
  const group = allFiles.filter((f) => {
    const mm = SHARD_RE.exec(f);
    return mm && mm[1] === prefix && mm[3] === total;
  });
  return group.length > 0 ? group : [file];
}

/** Snapshot the install manager's current state into the wire response shape. */
function installsResponse(installs: IInstallManager): InstallsResponse {
  return {
    installs: installs.installs(),
    builds: installs.builds(),
    activeId: installs.getActive()?.id ?? null,
  };
}

export async function startControlPlane(opts: ControlPlaneOptions): Promise<ControlPlaneHandle> {
  // Always loopback — the control plane is never exposed off-host by design.
  const port = await findFreePort(opts.startPort, LOOPBACK);

  const authed = (req: Request): boolean => {
    const tok = bearer(req);
    return tok !== null && constantTimeEqual(tok, opts.token);
  };

  const server = Bun.serve({
    hostname: LOOPBACK,
    port,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;

      // The single unauthenticated route.
      if (path === "/health" && req.method === "GET") {
        const body: HealthResponse = { ok: true, pid: opts.pid, startedAt: opts.startedAt };
        return json(body);
      }

      // Everything else requires the bearer token (constant-time check).
      if (!authed(req)) {
        return errorResponse(new LlamactlError("unauthorized", "missing or invalid bearer token"));
      }

      try {
        if (path === "/models" && req.method === "GET") {
          // Catalog view hides non-runnable projector (mmproj) files; they stay
          // in opts.models() so DELETE /models/:id can still target them.
          const body: ModelsResponse = { models: runnableModels(opts.models()) };
          return json(body);
        }

        if (path === "/ps" && req.method === "GET") {
          const body: PsResponse = { running: opts.supervisor.list() };
          return json(body);
        }

        if (path === "/stats" && req.method === "GET") {
          const body: StatsResponse = {
            stats: opts.sampler.snapshot(),
            llamaServer: await opts.supervisor.serverInfo(),
          };
          return json(body);
        }

        if (path === "/llama/flags" && req.method === "GET") {
          const body: LlamaFlagsResponse = { spec: await opts.supervisor.serverFlags() };
          return json(body);
        }

        if (path === "/hf/search" && req.method === "GET") {
          const q = url.searchParams.get("q") ?? "";
          if (q.trim().length === 0) throw new LlamactlError("bad_request", "query 'q' is required");
          const token = await opts.getHfToken();
          const body: HfSearchResponse = { repos: await searchModels(q, { token }) };
          return json(body);
        }

        if (path === "/hf/files" && req.method === "GET") {
          const repo = url.searchParams.get("repo") ?? "";
          if (repo.trim().length === 0) throw new LlamactlError("bad_request", "query 'repo' is required");
          const token = await opts.getHfToken();
          const body: HfFilesResponse = { files: await listGgufFiles(repo, { token }) };
          return json(body);
        }

        if (path === "/downloads" && req.method === "GET") {
          const body: DownloadsResponse = { downloads: opts.downloads.list() };
          return json(body);
        }

        if (path === "/pull" && req.method === "POST") {
          const reqBody = (await req.json()) as PullRequest;
          if (!reqBody || typeof reqBody.repo !== "string" || typeof reqBody.file !== "string") {
            throw new LlamactlError("bad_request", "fields 'repo' and 'file' are required");
          }
          // Expand a sharded model to its whole group so it's usable once done.
          let files = [reqBody.file];
          if (SHARD_RE.test(reqBody.file)) {
            const token = await opts.getHfToken();
            const all = await listGgufFiles(reqBody.repo, { token, revision: reqBody.revision });
            files = shardGroup(reqBody.file, all.map((f) => f.rfilename));
          }
          const started: Download[] = files.map((f) =>
            opts.downloads.start(reqBody.repo, f, reqBody.revision),
          );
          const body: DownloadsResponse = { downloads: started };
          return json(body);
        }

        // /downloads/:id/cancel — checked before the bare /downloads/:id DELETE.
        const cancelMatch = /^\/downloads\/(.+)\/cancel$/.exec(path);
        if (cancelMatch && req.method === "POST") {
          const id = decodeURIComponent(cancelMatch[1]!);
          opts.downloads.cancel(id);
          return json({ ok: true });
        }

        // /downloads/:id/retry — resume an errored/canceled download.
        const retryMatch = /^\/downloads\/(.+)\/retry$/.exec(path);
        if (retryMatch && req.method === "POST") {
          const id = decodeURIComponent(retryMatch[1]!);
          opts.downloads.retry(id);
          const body: DownloadsResponse = { downloads: opts.downloads.list() };
          return json(body);
        }

        // DELETE /downloads/:id — dismiss a download (clear errored/finished).
        const downloadMatch = /^\/downloads\/(.+)$/.exec(path);
        if (downloadMatch && req.method === "DELETE") {
          const id = decodeURIComponent(downloadMatch[1]!);
          opts.downloads.dismiss(id);
          const body: DownloadsResponse = { downloads: opts.downloads.list() };
          return json(body);
        }

        if (path === "/instances" && req.method === "GET") {
          const body: InstancesResponse = { instances: opts.instances.list() };
          return json(body);
        }

        if (path === "/favorites" && req.method === "GET") {
          const body: FavoritesResponse = { favorites: opts.favorites.list() };
          return json(body);
        }

        // POST /favorites/:id/toggle — flip a row's favorite state, return the new set.
        const favToggleMatch = /^\/favorites\/(.+)\/toggle$/.exec(path);
        if (favToggleMatch && req.method === "POST") {
          const id = decodeURIComponent(favToggleMatch[1]!);
          await opts.favorites.toggle(id);
          const body: FavoritesResponse = { favorites: opts.favorites.list() };
          return json(body);
        }

        if (path === "/installs" && req.method === "GET") {
          return json(installsResponse(opts.installs));
        }

        if (path === "/installs" && req.method === "POST") {
          const body = (await req.json()) as BuildRequest;
          if (!body || (body.repo !== undefined && typeof body.repo !== "string")) {
            throw new LlamactlError("bad_request", "field 'repo' must be a string");
          }
          // An empty/omitted repo defaults to upstream llama.cpp (in start()).
          opts.installs.start(body);
          return json(installsResponse(opts.installs));
        }

        if (path === "/installs/active" && req.method === "PUT") {
          const body = (await req.json()) as ActiveInstallRequest;
          await opts.installs.setActive(body?.id ?? null);
          return json(installsResponse(opts.installs));
        }

        // POST /installs/:id/cancel — checked before DELETE /installs/:id so the
        // two routes don't collide.
        const installCancelMatch = /^\/installs\/(.+)\/cancel$/.exec(path);
        if (installCancelMatch && req.method === "POST") {
          const id = decodeURIComponent(installCancelMatch[1]!);
          opts.installs.cancel(id);
          return json(installsResponse(opts.installs));
        }

        // POST /installs/:id/update — fetch the latest code for the ref and rebuild.
        const installUpdateMatch = /^\/installs\/(.+)\/update$/.exec(path);
        if (installUpdateMatch && req.method === "POST") {
          const id = decodeURIComponent(installUpdateMatch[1]!);
          const body = (await req.json().catch(() => ({}))) as InstallUpdateRequest;
          opts.installs.update(id, body ?? undefined);
          return json(installsResponse(opts.installs));
        }

        // PATCH /installs/:id — rename a managed install.
        const installMatch = /^\/installs\/(.+)$/.exec(path);
        if (installMatch && req.method === "PATCH") {
          const id = decodeURIComponent(installMatch[1]!);
          const body = (await req.json()) as InstallRenameRequest;
          if (!body || typeof body.name !== "string") {
            throw new LlamactlError("bad_request", "field 'name' is required");
          }
          await opts.installs.rename(id, body.name);
          return json(installsResponse(opts.installs));
        }

        // DELETE /installs/:id — remove a managed install.
        if (installMatch && req.method === "DELETE") {
          const id = decodeURIComponent(installMatch[1]!);
          await opts.installs.remove(id);
          return json(installsResponse(opts.installs));
        }

        // DELETE /models/:id — remove a model's file(s) from disk.
        const modelMatch = /^\/models\/(.+)$/.exec(path);
        if (modelMatch && req.method === "DELETE") {
          const id = decodeURIComponent(modelMatch[1]!);
          const model = opts.models().find((m) => m.id === id);
          if (!model) {
            throw new LlamactlError("model_not_found", `no model "${id}"`, { detail: { id } });
          }
          if (opts.supervisor.get(id)) {
            throw new LlamactlError("already_running", `stop "${id}" before deleting it`, {
              detail: { id },
            });
          }
          const removed = await deleteModelFiles(model);
          opts.refreshModels();
          return json({ ok: true, removed });
        }

        if (path === "/instances" && req.method === "POST") {
          const body = (await req.json()) as InstanceUpsertRequest;
          if (!body || typeof body.spec !== "object" || body.spec === null) {
            throw new LlamactlError("bad_request", "field 'spec' is required");
          }
          const created = await opts.instances.create({ id: body.id, name: body.name, spec: body.spec });
          return json(created, 201);
        }

        // /instances/:id (PUT update, DELETE remove)
        const instanceMatch = /^\/instances\/(.+)$/.exec(path);
        if (instanceMatch) {
          const id = decodeURIComponent(instanceMatch[1]!);
          if (req.method === "PUT") {
            const body = (await req.json()) as { name?: string; spec?: LaunchSpec };
            const updated = await opts.instances.update(id, { name: body?.name, spec: body?.spec });
            return json(updated);
          }
          if (req.method === "DELETE") {
            await opts.instances.remove(id);
            return json({ ok: true });
          }
        }

        if (path === "/start" && req.method === "POST") {
          const reqBody = (await req.json()) as StartRequest;
          const spec = resolveStartSpec(reqBody ?? {}, opts.instances);
          const running = await opts.supervisor.start(spec);
          return json(running);
        }

        if (path === "/stop" && req.method === "POST") {
          const reqBody = (await req.json()) as StopRequest;
          if (!reqBody || typeof reqBody.model !== "string" || reqBody.model.length === 0) {
            throw new LlamactlError("bad_request", "field 'model' is required");
          }
          const stopped = await opts.supervisor.stop(reqBody.model);
          return json(stopped);
        }

        if (path === "/shutdown" && req.method === "POST") {
          // Acknowledge, then trigger shutdown on the next tick so the response flushes.
          queueMicrotask(() => opts.onShutdown());
          return json({ ok: true });
        }

        return errorResponse(new LlamactlError("not_found", `no such route: ${req.method} ${path}`));
      } catch (e) {
        return errorResponse(e);
      }
    },
  });

  return {
    server,
    url: `http://${LOOPBACK}:${port}`,
    port,
    stop: () => server.stop(true),
  };
}
