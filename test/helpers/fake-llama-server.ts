#!/usr/bin/env bun
/**
 * A tiny fake `llama-server` used by tests. It mimics the subset of the
 * llama.cpp HTTP surface that llamactl relies on:
 *
 *   GET  /health                -> 503 {status:"loading model"} until "ready",
 *                                  then 200 {status:"ok"}
 *   GET  /v1/models             -> the served model id
 *   POST /v1/chat/completions   -> non-streaming JSON, or SSE when {stream:true}
 *   POST /v1/completions        -> same
 *   POST /v1/embeddings         -> a fixed embedding
 *
 * It can be used two ways:
 *   1. In-process:  `const s = startFakeServer({...})` (proxy tests).
 *   2. As a spawned binary: run this file with `--port N` so the supervisor can
 *      treat it exactly like the real `llama-server` (supervisor tests).
 *
 * Behaviour knobs (env vars, so they survive a subprocess spawn):
 *   FAKE_READY_DELAY_MS   ms before /health flips to 200 (default 0)
 *   FAKE_CRASH_AFTER_MS   if set, process exits non-zero after N ms (crash test)
 *   FAKE_FAIL_START       if "1", exit(1) immediately without binding (launch-fail)
 *   FAKE_MODEL            model id reported by /v1/models (default "fake-model")
 */

type BunServer = ReturnType<typeof Bun.serve>;

export interface FakeServerOptions {
  port?: number;
  /** ms before /health reports ready (200). Default 0 = immediately ready. */
  readyDelayMs?: number;
  /** Model id reported by the server. */
  model?: string;
}

export interface FakeServer {
  server: BunServer;
  port: number;
  url: string;
  /** Whether /health currently reports ready. */
  isReady: () => boolean;
  stop: () => void;
}

function nowMs(): number {
  // performance.now is allowed and monotonic; fine for relative timing in tests.
  return performance.now();
}

export function startFakeServer(opts: FakeServerOptions = {}): FakeServer {
  const model = opts.model ?? "fake-model";
  const readyDelay = opts.readyDelayMs ?? 0;
  const bornAt = nowMs();
  const ready = () => nowMs() - bornAt >= readyDelay;

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/health") {
        return ready()
          ? Response.json({ status: "ok" })
          : Response.json({ status: "loading model" }, { status: 503 });
      }

      if (path === "/v1/models") {
        return Response.json({
          object: "list",
          data: [{ id: model, object: "model", owned_by: "llamactl-fake" }],
        });
      }

      if (path === "/v1/embeddings" && req.method === "POST") {
        return Response.json({
          object: "list",
          model,
          data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
        });
      }

      if (
        (path === "/v1/chat/completions" || path === "/v1/completions") &&
        req.method === "POST"
      ) {
        let body: {
          stream?: boolean;
          messages?: { role?: string; content?: unknown }[];
        } = {};
        try {
          body = (await req.json()) as typeof body;
        } catch {
          /* tolerate empty body */
        }
        // Mirror llama-server's request validation (it 400s otherwise).
        if (
          path === "/v1/chat/completions" &&
          body.messages?.some((m) => m.role !== "assistant" && m.content == null)
        ) {
          return Response.json(
            { error: { message: "All non-assistant messages must contain 'content'" } },
            { status: 400 },
          );
        }
        if (body.stream) {
          // SSE: emit a couple of chunks then [DONE]. Tests assert passthrough.
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const enc = new TextEncoder();
              const chunk = (data: unknown) =>
                controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
              chunk({ id: "c1", model, choices: [{ delta: { content: "hello" } }] });
              chunk({ id: "c1", model, choices: [{ delta: { content: " world" } }] });
              controller.enqueue(enc.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
            },
          });
        }
        return Response.json({
          id: "c1",
          object: "chat.completion",
          model,
          choices: [
            { index: 0, message: { role: "assistant", content: "hello world" }, finish_reason: "stop" },
          ],
        });
      }

      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  const boundPort = server.port ?? opts.port ?? 0;
  return {
    server,
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}`,
    isReady: ready,
    stop: () => server.stop(true),
  };
}

// When spawned as a subprocess (the supervisor treats this as `llama-server`).
if (import.meta.main) {
  if (process.env.FAKE_FAIL_START === "1") {
    process.stderr.write("fake-llama-server: simulated launch failure\n");
    process.exit(1);
  }

  // Mimic `llama-server --version` (prints to stderr like llama.cpp, then exits).
  if (process.argv.slice(2).includes("--version")) {
    process.stderr.write("version: 9999 (fake-llama)\nbuilt with fake cc for test\n");
    process.exit(0);
  }

  // Parse `--port N` out of the llama-server-style argv; ignore everything else.
  let port = 0;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "--port" || argv[i] === "-p") && argv[i + 1]) {
      port = Number.parseInt(argv[i + 1]!, 10);
      break;
    }
  }

  const readyDelayMs = Number.parseInt(process.env.FAKE_READY_DELAY_MS ?? "0", 10) || 0;
  const model = process.env.FAKE_MODEL ?? "fake-model";
  const fake = startFakeServer({ port, readyDelayMs, model });
  process.stdout.write(`fake-llama-server listening on ${fake.url}\n`);

  const crashAfter = process.env.FAKE_CRASH_AFTER_MS
    ? Number.parseInt(process.env.FAKE_CRASH_AFTER_MS, 10)
    : 0;
  if (crashAfter > 0) {
    setTimeout(() => {
      process.stderr.write("fake-llama-server: simulated crash\n");
      process.exit(1);
    }, crashAfter);
  }
}
