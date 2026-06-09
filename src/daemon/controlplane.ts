/**
 * The control plane: a loopback-only HTTP listener the CLI uses to drive the
 * daemon. Every route except `GET /health` requires the bearer token, compared
 * in constant time. This listener is STRUCTURALLY separate from the proxy and
 * is hard-wired to 127.0.0.1 — it must never be bindable off-loopback.
 */

import type {
  HealthResponse,
  ISupervisor,
  Model,
  ModelsResponse,
  PsResponse,
  StartRequest,
  StopRequest,
} from "../types.ts";
import { BunstashError, toBunstashError } from "../errors.ts";
import { findFreePort } from "../net/ports.ts";
import { constantTimeEqual } from "./runtime.ts";

export interface ControlPlaneOptions {
  token: string;
  supervisor: ISupervisor;
  /** Returns the current set of discovered models. */
  models: () => Model[];
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
  const err = toBunstashError(e);
  return json(err.toApiError(), err.httpStatus);
}

/** Extract a bearer token from the Authorization header, or null. */
function bearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1]! : null;
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
        return errorResponse(new BunstashError("unauthorized", "missing or invalid bearer token"));
      }

      try {
        if (path === "/models" && req.method === "GET") {
          const body: ModelsResponse = { models: opts.models() };
          return json(body);
        }

        if (path === "/ps" && req.method === "GET") {
          const body: PsResponse = { running: opts.supervisor.list() };
          return json(body);
        }

        if (path === "/start" && req.method === "POST") {
          const reqBody = (await req.json()) as StartRequest;
          if (!reqBody || typeof reqBody.model !== "string" || reqBody.model.length === 0) {
            throw new BunstashError("bad_request", "field 'model' is required");
          }
          const running = await opts.supervisor.start(reqBody.model, reqBody.ctx);
          return json(running);
        }

        if (path === "/stop" && req.method === "POST") {
          const reqBody = (await req.json()) as StopRequest;
          if (!reqBody || typeof reqBody.model !== "string" || reqBody.model.length === 0) {
            throw new BunstashError("bad_request", "field 'model' is required");
          }
          const stopped = await opts.supervisor.stop(reqBody.model);
          return json(stopped);
        }

        if (path === "/shutdown" && req.method === "POST") {
          // Acknowledge, then trigger shutdown on the next tick so the response flushes.
          queueMicrotask(() => opts.onShutdown());
          return json({ ok: true });
        }

        return errorResponse(new BunstashError("not_found", `no such route: ${req.method} ${path}`));
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
