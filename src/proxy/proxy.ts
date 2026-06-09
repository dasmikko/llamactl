/**
 * OpenAI-compatible reverse proxy.
 *
 * Accepts OpenAI-style requests, ensures the requested model is running (via the
 * supervisor), and streams the upstream llama-server response straight back to
 * the client. Adds NO measurable latency: the only request body it reads is the
 * small JSON request (to learn the model id); the RESPONSE body is never
 * buffered — it is piped through as a ReadableStream.
 *
 * The proxy depends ONLY on the `ISupervisor` interface, never on a concrete
 * supervisor, so it can be built and tested in isolation.
 */

import type { Config, ISupervisor, Model, RunningModel } from "../types.ts";
import { BunstashError, toBunstashError } from "../errors.ts";

export interface ProxyOptions {
  config: Config;
  supervisor: ISupervisor;
  /** Discovered models, for GET /v1/models. */
  models: () => Model[];
  /** Listener host; defaults to config.proxy.host. */
  host?: string;
  /** Listener port; defaults to config.proxy.port. */
  port?: number;
}

export interface ProxyHandle {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  port: number;
  stop(): void;
}

/** OpenAI-style routes that proxy to an upstream llama-server. */
const FORWARD_PATHS = new Set([
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/embeddings",
]);

/** Serialize a BunstashError to the standard JSON error envelope + status. */
function errorResponse(err: BunstashError): Response {
  return Response.json(err.toApiError(), { status: err.httpStatus });
}

/**
 * Copy request headers for the upstream call, dropping hop-by-hop / length
 * headers that must not be forwarded verbatim (we re-serialize the body, so the
 * original content-length is wrong).
 */
function upstreamHeaders(req: Request): Headers {
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("connection");
  // We always send JSON upstream.
  headers.set("content-type", "application/json");
  return headers;
}

/**
 * Build the client-facing response from the upstream response, STREAMING the
 * body straight through (never buffered). Copies the relevant upstream headers
 * and stamps the bunstash provenance headers.
 */
function streamResponse(
  upstream: Response,
  servedBy: string,
  fallbackReason?: string,
): Response {
  const headers = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  const cacheControl = upstream.headers.get("cache-control");
  if (cacheControl) headers.set("cache-control", cacheControl);
  headers.set("x-bunstash-served-by", servedBy);
  if (fallbackReason !== undefined) {
    headers.set("x-bunstash-fallback-reason", fallbackReason);
  }
  // Pass the upstream body (a ReadableStream) through untouched.
  return new Response(upstream.body, { status: upstream.status, headers });
}

/** Forward an already-serialized request body to a ready upstream child. */
async function forward(
  target: RunningModel,
  pathname: string,
  headers: Headers,
  bodyText: string,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${target.port}${pathname}`, {
    method: "POST",
    headers,
    body: bodyText,
  });
}

/**
 * Create the request handler. Pure function of the options; can be used
 * directly (tests, embedding) or via {@link startProxy}.
 */
export function createProxyHandler(
  opts: ProxyOptions,
): (req: Request) => Promise<Response> {
  const { config, supervisor } = opts;

  return async function handler(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const path = url.pathname;

      // --- Liveness / discovery routes -------------------------------------
      if (req.method === "GET" && path === "/") {
        return new Response("bunstash is running", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      if (req.method === "GET" && path === "/health") {
        return Response.json({ status: "ok" });
      }

      if (req.method === "GET" && path === "/v1/models") {
        return Response.json({
          object: "list",
          data: opts.models().map((m) => ({
            id: m.id,
            object: "model",
            owned_by: "bunstash",
          })),
        });
      }

      // --- OpenAI forwarding routes ----------------------------------------
      if (req.method === "POST" && FORWARD_PATHS.has(path)) {
        // Read the (small) request body to learn the model id, then re-serialize
        // it for the upstream call. This is the only body we ever buffer.
        let parsed: unknown;
        try {
          parsed = await req.json();
        } catch {
          throw new BunstashError("bad_request", "request body is not valid JSON");
        }

        const model =
          parsed !== null && typeof parsed === "object"
            ? (parsed as Record<string, unknown>).model
            : undefined;
        if (typeof model !== "string" || model.trim() === "") {
          throw new BunstashError("bad_request", "missing 'model'");
        }

        const bodyText = JSON.stringify(parsed);
        const headers = upstreamHeaders(req);

        // 1) Try the requested model.
        let target: RunningModel;
        try {
          target = await supervisor.ensureReady(model);
        } catch (e) {
          const original = toBunstashError(e);
          // 2) Optional fallback to a ready peer.
          if (config.fallbackEnabled) {
            const peer = supervisor
              .list()
              .find((r) => r.status === "ready" && r.modelId !== model);
            if (peer) {
              const upstream = await forward(peer, path, headers, bodyText);
              return streamResponse(
                upstream,
                peer.modelId,
                `${original.code}: ${original.message}`,
              );
            }
          }
          // No fallback available — hard fail with the original error.
          return errorResponse(original);
        }

        const upstream = await forward(target, path, headers, bodyText);
        return streamResponse(upstream, target.modelId);
      }

      // --- Anything else ---------------------------------------------------
      throw new BunstashError("not_found", `no route for ${req.method} ${path}`);
    } catch (e) {
      // No silent failures: coerce any unexpected throw into an ApiError.
      return errorResponse(toBunstashError(e));
    }
  };
}

/**
 * Start the proxy on `host:port` (defaults from config.proxy) and return a
 * handle. `stop()` performs a forceful close.
 */
export function startProxy(opts: ProxyOptions): ProxyHandle {
  const host = opts.host ?? opts.config.proxy.host;
  const port = opts.port ?? opts.config.proxy.port;
  const handler = createProxyHandler(opts);

  const server = Bun.serve({ hostname: host, port, fetch: handler });
  const boundPort = server.port ?? port;
  return {
    server,
    port: boundPort,
    url: `http://${host}:${boundPort}`,
    stop: () => server.stop(true),
  };
}
