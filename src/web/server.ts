/**
 * The web front end: serves a single-page app and proxies its `/api/*` calls to
 * the daemon's control plane, injecting the bearer token server-side.
 *
 * Why a separate listener instead of routes bolted onto the control plane: the
 * control plane is hard-wired to loopback and authenticates with a token that
 * rotates on every daemon start and lives in a 0600 file. A browser can neither
 * read that file nor reach that port from another machine. This layer holds the
 * token, so it never reaches the browser, and it can bind off-loopback under
 * its own session token without weakening the control plane's invariant.
 *
 * It is a plain client of the daemon — it adds no privileges the CLI doesn't
 * already have, and requires no daemon-side changes. Four things it serves
 * itself rather than proxying, because they need host access the daemon has no
 * route for: the log tails, the chat passthrough to a running instance, the
 * daemon restart, and the static assets.
 */

import type { InstallsResponse, LogTailResponse, PsResponse, RunningModel } from "../types.ts";
import { LlamactlError, toLlamactlError } from "../errors.ts";
import { constantTimeEqual, isProcessAlive } from "../daemon/runtime.ts";
import { findFreePort } from "../net/ports.ts";
import { tailLog } from "../logs/tail.ts";
import { ASSETS } from "./assets.ts";
import { SHARED_MODULES } from "./modules.ts";

/** Where the control plane currently lives, and the credentials to reach it. */
export interface UpstreamTarget {
  controlUrl: string;
  token: string;
  /** Daemon PID, so the restart route can signal it. */
  pid: number;
}

export interface WebServerOptions {
  /** Bind address. Anything other than loopback requires `token`. */
  host: string;
  /** First port to try; scans upward if taken. */
  port: number;
  /**
   * Session token browsers must present, or null for open access. Null is only
   * permitted on a loopback bind — `startWebServer` rejects it otherwise.
   */
  token: string | null;
  /**
   * Resolve the control plane. Called lazily and again after a 401, because the
   * daemon rotates its token on every restart and a cached one goes stale.
   */
  connect: () => Promise<UpstreamTarget>;
}

export interface WebServerHandle {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  port: number;
  stop: () => void;
}

/** Lines of log tail returned by the log routes (matches the TUI's window). */
const TAIL_LINES = 500;

/** Name of the cookie that carries the session token after a `?token=` visit. */
const COOKIE = "llamactl_web";

/**
 * Request headers that must not be relayed upstream. Hop-by-hop headers are
 * per-connection by definition; `authorization` and `cookie` are the browser's
 * credentials for *this* server and have no meaning to the daemon — forwarding
 * them would leak the session token into another process's request handling.
 */
const STRIP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "authorization",
  "cookie",
]);

/**
 * Response headers not to relay back. `fetch` has already decoded the body, so
 * passing the original encoding/length through would leave the browser trying
 * to gunzip plain text or waiting on bytes that never come.
 */
const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
]);

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorResponse(e: unknown): Response {
  const err = toLlamactlError(e);
  return json(err.toApiError(), err.httpStatus);
}

/** Read one cookie value out of a Cookie header. */
function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** Extract a bearer token from the Authorization header, or null. */
function bearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1]! : null;
}

/**
 * Reject cross-site requests. A browser sets `Origin` itself and a page cannot
 * forge it, so requiring it to match the Host we were reached on blocks both
 * CSRF and DNS-rebinding attempts against a local server — which matters most
 * in the no-token loopback mode, where any page the user visits could otherwise
 * POST to us. A missing Origin means a non-browser client (curl) or a
 * same-origin navigation, both fine.
 */
export function originAllowed(origin: string | null, host: string | null): boolean {
  if (origin === null) return true;
  if (host === null) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The loopback endpoint a running child serves its OpenAI-compatible API on. */
function instanceUrl(rec: RunningModel): string {
  return `http://${rec.spec.host ?? "127.0.0.1"}:${rec.port}`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function startWebServer(opts: WebServerOptions): Promise<WebServerHandle> {
  if (opts.token === null && !isLoopback(opts.host)) {
    throw new LlamactlError(
      "bad_request",
      `refusing to bind ${opts.host} without a session token — pass --web-token, or bind 127.0.0.1`,
    );
  }

  const port = await findFreePort(opts.port, opts.host);

  // The upstream is resolved once and re-resolved on a 401. `pending`
  // deduplicates concurrent resolves so a burst of polls forks one daemon at
  // most, not one per request.
  let upstream: UpstreamTarget | null = null;
  let pending: Promise<UpstreamTarget> | null = null;

  const target = async (): Promise<UpstreamTarget> => {
    if (upstream) return upstream;
    pending ??= opts
      .connect()
      .then((t) => {
        upstream = t;
        return t;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  const invalidate = (): void => {
    upstream = null;
  };

  /** Authenticated control-plane request that retries once on a rotated token. */
  const upstreamFetch = async (
    method: string,
    path: string,
    headers: Headers,
    body: ArrayBuffer | null,
  ): Promise<Response> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const t = await target();
      const h = new Headers(headers);
      h.set("authorization", `Bearer ${t.token}`);
      let res: Response;
      try {
        res = await fetch(t.controlUrl + path, {
          method,
          headers: h,
          ...(body !== null ? { body } : {}),
          redirect: "manual",
        });
      } catch (e) {
        // A dead daemon leaves a stale cached URL behind; drop it and let the
        // next attempt re-resolve (which respawns the daemon).
        invalidate();
        if (attempt === 1) {
          throw new LlamactlError(
            "daemon_unreachable",
            `could not reach the daemon at ${t.controlUrl}: ${(e as Error).message}`,
          );
        }
        continue;
      }
      // The daemon rotates its token on restart: one 401 means "re-resolve",
      // not "unauthorized".
      if (res.status === 401 && attempt === 0) {
        invalidate();
        continue;
      }
      return res;
    }
    // Unreachable: the loop either returns or throws.
    throw new LlamactlError("internal", "upstream request did not complete");
  };

  /** Small typed GET against the control plane (used by the local routes). */
  const upstreamJson = async <T>(path: string): Promise<T> => {
    const res = await upstreamFetch("GET", path, new Headers(), null);
    const text = await res.text();
    if (!res.ok) throw new LlamactlError("internal", `daemon returned HTTP ${res.status}: ${text}`);
    return JSON.parse(text) as T;
  };

  /** Look up a running child by model id, or throw the standard not_running. */
  const requireRunning = async (modelId: string): Promise<RunningModel> => {
    const ps = await upstreamJson<PsResponse>("/ps");
    const rec = ps.running.find((r) => r.modelId === modelId);
    if (!rec) {
      throw new LlamactlError("not_running", `not running: ${modelId}`, {
        detail: { model: modelId },
      });
    }
    return rec;
  };

  const sessionOk = (req: Request, url: URL): boolean => {
    if (opts.token === null) return true;
    const tok =
      bearer(req) ?? url.searchParams.get("token") ?? cookieValue(req.headers.get("cookie"), COOKIE);
    return tok !== null && constantTimeEqual(tok, opts.token);
  };

  const server = Bun.serve({
    hostname: opts.host,
    port,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;

      if (!originAllowed(req.headers.get("origin"), req.headers.get("host"))) {
        return errorResponse(new LlamactlError("unauthorized", "cross-origin request rejected"));
      }

      if (!sessionOk(req, url)) {
        return errorResponse(new LlamactlError("unauthorized", "missing or invalid session token"));
      }

      try {
        // A `?token=…` visit trades the query parameter for a cookie and
        // redirects, so the token stops riding along in the address bar (and in
        // the Referer of anything the page loads).
        if (req.method === "GET" && url.searchParams.has("token") && opts.token !== null) {
          const clean = new URL(url);
          clean.searchParams.delete("token");
          return new Response(null, {
            status: 302,
            headers: {
              location: clean.pathname + clean.search,
              "set-cookie": `${COOKIE}=${encodeURIComponent(opts.token)}; Path=/; HttpOnly; SameSite=Strict`,
            },
          });
        }

        if (req.method === "GET") {
          const asset = ASSETS.get(path === "/" ? "/index.html" : path);
          if (asset) {
            return new Response(asset.body, { headers: { "content-type": asset.contentType } });
          }
          // Shared TUI logic, transpiled to ES modules (see modules.ts).
          const mod = SHARED_MODULES.get(path);
          if (mod !== undefined) {
            return new Response(mod, {
              headers: { "content-type": "text/javascript; charset=utf-8" },
            });
          }
        }

        // GET /api/logs/model/:id and /api/logs/build/:id — served here rather
        // than proxied: the web layer runs on the daemon's host, so it reads
        // the files directly. Both resolve the path from the daemon's own
        // records and never from the request — a client-supplied path here
        // would be an arbitrary-file-read hole.
        const modelLog = /^\/api\/logs\/model\/(.+)$/.exec(path);
        if (modelLog && req.method === "GET") {
          const modelId = decodeURIComponent(modelLog[1]!);
          const rec = await requireRunning(modelId);
          const tail = await tailLog(rec.logPath, TAIL_LINES);
          const body: LogTailResponse = { modelId, logPath: rec.logPath, ...tail };
          return json(body);
        }

        const buildLog = /^\/api\/logs\/build\/(.+)$/.exec(path);
        if (buildLog && req.method === "GET") {
          const buildId = decodeURIComponent(buildLog[1]!);
          const installs = await upstreamJson<InstallsResponse>("/installs");
          const build = installs.builds.find((b) => b.id === buildId);
          if (!build) {
            throw new LlamactlError("not_found", `no build "${buildId}"`, {
              detail: { id: buildId },
            });
          }
          const tail = await tailLog(build.logPath, TAIL_LINES);
          const body: LogTailResponse = { modelId: buildId, logPath: build.logPath, ...tail };
          return json(body);
        }

        // POST /api/chat/:modelId — passthrough to a running child's
        // OpenAI-compatible endpoint. The TUI talks to that port directly; a
        // browser can't (different origin, and the port isn't reachable when
        // the UI is opened from another machine), so this relays it and streams
        // the SSE body back untouched.
        const chat = /^\/api\/chat\/(.+)$/.exec(path);
        if (chat && req.method === "POST") {
          const modelId = decodeURIComponent(chat[1]!);
          const rec = await requireRunning(modelId);
          const body = await req.arrayBuffer();
          let res: Response;
          try {
            res = await fetch(`${instanceUrl(rec)}/v1/chat/completions`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
            });
          } catch (e) {
            throw new LlamactlError(
              "internal",
              `could not reach ${rec.name} at ${instanceUrl(rec)}: ${(e as Error).message}`,
            );
          }
          const out = new Headers();
          for (const [k, v] of res.headers) {
            if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) out.set(k, v);
          }
          return new Response(res.body, { status: res.status, headers: out });
        }

        // POST /api/daemon/restart — the TUI's Ctrl+R. A browser can't fork a
        // process, so the restart runs here: signal the daemon, wait for it to
        // exit, and drop the cached upstream so the next request respawns it
        // through connectDaemon.
        if (path === "/api/daemon/restart" && req.method === "POST") {
          const t = await target();
          invalidate();
          try {
            process.kill(t.pid, "SIGTERM");
          } catch {
            // Already gone; the next resolve respawns it either way.
          }
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline && isProcessAlive(t.pid)) await sleep(100);
          const next = await target();
          return json({ ok: true, pid: next.pid });
        }

        if (path === "/api" || path.startsWith("/api/")) {
          // `url.pathname` is already normalized by the URL parser, so no `..`
          // survives to escape the control plane's route space.
          const upstreamPath = path.slice("/api".length) + url.search;
          const headers = new Headers();
          for (const [k, v] of req.headers) {
            if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) headers.set(k, v);
          }
          const hasBody = req.method !== "GET" && req.method !== "HEAD";
          const body = hasBody ? await req.arrayBuffer() : null;
          const res = await upstreamFetch(req.method, upstreamPath, headers, body);
          const out = new Headers();
          for (const [k, v] of res.headers) {
            if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) out.set(k, v);
          }
          return new Response(res.body, { status: res.status, headers: out });
        }

        return errorResponse(new LlamactlError("not_found", `no such route: ${req.method} ${path}`));
      } catch (e) {
        return errorResponse(e);
      }
    },
  });

  return {
    server,
    url: `http://${isLoopback(opts.host) ? "127.0.0.1" : opts.host}:${port}`,
    port,
    stop: () => server.stop(true),
  };
}
