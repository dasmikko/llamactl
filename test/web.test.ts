/**
 * Tests for the web layer: the /api proxy (token injection, credential
 * stripping, re-resolve on a rotated token), the locally-served log route, and
 * the session/origin guards. The "control plane" here is a stub Bun.serve that
 * only checks the bearer token, so nothing needs a daemon or a real model.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiError, LogTailResponse, PsResponse, RunningModel } from "../src/types.ts";
import { startWebServer, originAllowed, type WebServerHandle } from "../src/web/server.ts";
import { tailLog, sanitizeLogLine } from "../src/logs/tail.ts";
import { findFreePort } from "../src/net/ports.ts";

let tmp: string;
let logPath: string;
let buildLogPath: string;

/** `Response.json()` is `unknown` under Bun's types; name the shape here. */
async function bodyOf<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** The error code from a standard `{ error: { code, message } }` envelope. */
async function errorCode(res: Response): Promise<string> {
  return (await bodyOf<ApiError>(res)).error.code;
}

/** Stand-in control plane: token-checked, records what it received. */
interface FakeUpstream {
  server: ReturnType<typeof Bun.serve>;
  url: string;
  /** Current token; reassign to simulate a daemon restart rotating it. */
  token: string;
  /** Headers of the last request that got through. */
  lastHeaders: Headers | null;
  lastBody: string | null;
  requests: string[];
}

async function startFakeUpstream(): Promise<FakeUpstream> {
  const port = await findFreePort(49500);
  const state: FakeUpstream = {
    server: undefined as unknown as ReturnType<typeof Bun.serve>,
    url: `http://127.0.0.1:${port}`,
    token: "token-one",
    lastHeaders: null,
    lastBody: null,
    requests: [],
  };

  state.server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      if (auth !== `Bearer ${state.token}`) {
        return new Response(
          JSON.stringify({ error: { code: "unauthorized", message: "bad token" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      state.requests.push(`${req.method} ${url.pathname}${url.search}`);
      state.lastHeaders = req.headers;
      state.lastBody = req.method === "GET" ? null : await req.text();

      if (url.pathname === "/ps") {
        const running: RunningModel = {
          modelId: "alpha",
          name: "alpha",
          path: "/models/alpha.gguf",
          pid: 4242,
          port: instance.port,
          status: "ready",
          startedAt: 0,
          restarts: 0,
          logPath,
          spec: { model: "alpha" },
        };
        const body: PsResponse = { running: [running] };
        return Response.json(body);
      }
      if (url.pathname === "/models") return Response.json({ models: [] });
      if (url.pathname === "/start") return Response.json({ ok: true, echo: state.lastBody });
      if (url.pathname === "/installs") {
        return Response.json({
          installs: [],
          builds: [{ id: "build-1", name: "b1", logPath: buildLogPath, status: "building" }],
          activeId: null,
        });
      }
      return new Response(
        JSON.stringify({ error: { code: "not_found", message: "nope" } }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    },
  });
  return state;
}

/**
 * Stand-in for a running llama-server child: answers /v1/chat/completions with
 * a two-event SSE stream, so the passthrough can be tested without a model.
 */
interface FakeInstance {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  lastBody: string | null;
}

async function startFakeInstance(): Promise<FakeInstance> {
  const port = await findFreePort(49550);
  const state: FakeInstance = {
    server: undefined as unknown as ReturnType<typeof Bun.serve>,
    port,
    lastBody: null,
  };
  state.server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      state.lastBody = await req.text();
      const body =
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n` +
        "data: [DONE]\n\n";
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return state;
}

let upstream: FakeUpstream;
let instance: FakeInstance;
let web: WebServerHandle;
/** Number of times the web server re-resolved the control plane. */
let connects = 0;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "llamactl-web-"));
  logPath = join(tmp, "alpha.log");
  await writeFile(logPath, "first line\n\x1b[32mgreen\x1b[0m line\nlast line\n");
  buildLogPath = join(tmp, "build-1.log");
  await writeFile(buildLogPath, "configuring\nbuilding\n");

  instance = await startFakeInstance();
  upstream = await startFakeUpstream();
  web = await startWebServer({
    host: "127.0.0.1",
    port: await findFreePort(49600),
    token: null,
    connect: async () => {
      connects++;
      return { controlUrl: upstream.url, token: upstream.token, pid: process.pid };
    },
  });
});

afterAll(async () => {
  web?.stop();
  upstream?.server.stop(true);
  instance?.server.stop(true);
  await rm(tmp, { recursive: true, force: true });
});

describe("static page", () => {
  test("GET / serves the SPA", async () => {
    const res = await fetch(`${web.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<title>llamactl</title>");
    expect(html).toContain('<script type="module" src="/app.js">');
  });

  test("the client reaches the daemon only through the same-origin proxy", async () => {
    const src = await (await fetch(`${web.url}/lib/api.js`)).text();
    expect(src).toContain('fetch(`/api${path}`');
    // Nothing in browser code addresses the control plane directly or tries to
    // authenticate to it — the proxy is the only path, and it holds the token.
    expect(src).not.toContain("127.0.0.1");
    expect(src.toLowerCase()).not.toContain("authorization");
  });

  test("unknown routes 404 with the standard error envelope", async () => {
    const res = await fetch(`${web.url}/nope`);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
  });
});

describe("/api proxy", () => {
  test("forwards the path and injects the daemon token", async () => {
    const res = await fetch(`${web.url}/api/models`);
    expect(res.status).toBe(200);
    expect(await bodyOf<{ models: unknown[] }>(res)).toEqual({ models: [] });
    expect(upstream.requests.at(-1)).toBe("GET /models");
  });

  test("forwards the query string", async () => {
    await fetch(`${web.url}/api/hf/search?q=qwen%20moe`);
    expect(upstream.requests.at(-1)).toBe("GET /hf/search?q=qwen%20moe");
  });

  test("forwards POST bodies", async () => {
    const res = await fetch(`${web.url}/api/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "alpha" }),
    });
    expect(res.status).toBe(200);
    expect(upstream.lastBody).toBe('{"model":"alpha"}');
  });

  test("never relays browser credentials upstream", async () => {
    await fetch(`${web.url}/api/models`, {
      headers: { authorization: "Bearer browser-secret", cookie: "llamactl_web=browser-secret" },
    });
    // The Authorization header must be the daemon's, not the browser's.
    expect(upstream.lastHeaders?.get("authorization")).toBe(`Bearer ${upstream.token}`);
    expect(upstream.lastHeaders?.get("cookie")).toBeNull();
  });

  test("re-resolves the control plane when the token has rotated", async () => {
    const before = connects;
    upstream.token = "token-two"; // as a daemon restart would
    const res = await fetch(`${web.url}/api/models`);
    expect(res.status).toBe(200);
    expect(connects).toBe(before + 1);
  });

  test("passes an upstream error through with its status and code", async () => {
    const res = await fetch(`${web.url}/api/does-not-exist`);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
  });
});

describe("log route", () => {
  test("serves the tail of the path from the daemon's own /ps record", async () => {
    const res = await fetch(`${web.url}/api/logs/model/alpha`);
    expect(res.status).toBe(200);
    const body = await bodyOf<LogTailResponse>(res);
    expect(body.modelId).toBe("alpha");
    expect(body.logPath).toBe(logPath);
    expect(body.missing).toBe(false);
    expect(body.total).toBe(3);
    // ANSI escapes are stripped before the lines reach the browser.
    expect(body.lines).toEqual(["first line", "green line", "last line"]);
  });

  test("404s for a model that is not running", async () => {
    const res = await fetch(`${web.url}/api/logs/model/ghost`);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_running");
  });

  test("serves a build's log from the daemon's /installs record", async () => {
    const res = await fetch(`${web.url}/api/logs/build/build-1`);
    expect(res.status).toBe(200);
    const body = await bodyOf<LogTailResponse>(res);
    expect(body.logPath).toBe(buildLogPath);
    expect(body.lines).toEqual(["configuring", "building"]);
  });

  test("404s for an unknown build", async () => {
    const res = await fetch(`${web.url}/api/logs/build/nope`);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
  });

  test("reports a not-yet-created log file rather than failing", async () => {
    const missing = join(tmp, "nope.log");
    expect(await tailLog(missing, 10)).toEqual({ lines: [], total: 0, missing: true });
  });

  test("tailLog caps at maxLines and sanitizes", async () => {
    const p = join(tmp, "many.log");
    await writeFile(p, Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n");
    const tail = await tailLog(p, 5);
    expect(tail.total).toBe(50);
    expect(tail.lines).toEqual(["line 45", "line 46", "line 47", "line 48", "line 49"]);
    expect(sanitizeLogLine("[1/9]\r[9/9]")).toBe("[9/9]");
  });
});

describe("static assets and shared modules", () => {
  test("serves every asset in the manifest", async () => {
    for (const path of ["/style.css", "/app.js", "/lib/api.js", "/views/catalog.js"]) {
      const res = await fetch(`${web.url}${path}`);
      expect(`${path} → ${res.status}`).toBe(`${path} → 200`);
      expect(res.headers.get("content-type")).toContain(
        path.endsWith(".css") ? "text/css" : "text/javascript",
      );
    }
  });

  test("serves the TUI's row logic as a browser module, types stripped", async () => {
    const res = await fetch(`${web.url}/mod/tui/rows.js`);
    expect(res.status).toBe(200);
    const src = await res.text();
    expect(src).toContain("export function buildRows");
    expect(src).toContain("export function filterRows");
    // The `import type` line must be gone, not merely unused.
    expect(src).not.toContain("../types.ts");
  });

  test("rewrites a shared module's runtime import to its served URL", async () => {
    const src = await (await fetch(`${web.url}/mod/instances/spec.js`)).text();
    expect(src).toContain('from "/mod/errors.js"');
    expect(src).not.toContain("../errors.ts");
    // The constants the flag editor relies on survive the round trip.
    expect(src).toContain("CURATED_FLAGS");
    expect(src).toContain("CACHE_TYPES");
  });
});

describe("chat passthrough", () => {
  test("relays the body to the instance and streams the reply back", async () => {
    const res = await fetch(`${web.url}/api/chat/alpha`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"content":"hello"');
    expect(text).toContain("[DONE]");
    // The instance saw the browser's body verbatim.
    expect(instance.lastBody).toContain('"content":"hi"');
  });

  test("404s when the target model is not running", async () => {
    const res = await fetch(`${web.url}/api/chat/ghost`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_running");
  });
});

describe("daemon restart", () => {
  test("signals the daemon and re-resolves the control plane", async () => {
    // A stand-in for the daemon process, so the route has a real pid to kill
    // without taking down the test runner.
    const child = Bun.spawn({ cmd: ["sleep", "30"], stdout: "ignore", stderr: "ignore" });
    let resolves = 0;
    const handle = await startWebServer({
      host: "127.0.0.1",
      port: await findFreePort(49900),
      token: null,
      connect: async () => {
        resolves++;
        return { controlUrl: upstream.url, token: upstream.token, pid: child.pid };
      },
    });
    try {
      await fetch(`${handle.url}/api/ps`); // first resolve
      expect(resolves).toBe(1);
      const res = await fetch(`${handle.url}/api/daemon/restart`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(child.killed || (await child.exited) !== null).toBe(true);
      // The cached upstream was dropped, so the daemon was resolved afresh.
      expect(resolves).toBe(2);
    } finally {
      handle.stop();
      child.kill();
    }
  });
});

describe("origin guard", () => {
  test("accepts same-origin and credential-free clients, rejects cross-site", () => {
    expect(originAllowed(null, "127.0.0.1:48180")).toBe(true);
    expect(originAllowed("http://127.0.0.1:48180", "127.0.0.1:48180")).toBe(true);
    expect(originAllowed("http://evil.example", "127.0.0.1:48180")).toBe(false);
    // DNS rebinding: the attacker's page keeps its own Origin.
    expect(originAllowed("http://rebind.example", "127.0.0.1:48180")).toBe(false);
    expect(originAllowed("garbage", "127.0.0.1:48180")).toBe(false);
  });

  test("a cross-origin POST is refused before it reaches the daemon", async () => {
    const before = upstream.requests.length;
    const res = await fetch(`${web.url}/api/start`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ model: "alpha" }),
    });
    expect(res.status).toBe(401);
    expect(upstream.requests.length).toBe(before);
  });
});

describe("session token", () => {
  let guarded: WebServerHandle;

  beforeAll(async () => {
    guarded = await startWebServer({
      host: "127.0.0.1",
      port: await findFreePort(49700),
      token: "s".repeat(32),
      connect: async () => ({ controlUrl: upstream.url, token: upstream.token, pid: process.pid }),
    });
  });

  afterAll(() => guarded?.stop());

  test("rejects an unauthenticated request", async () => {
    const res = await fetch(`${guarded.url}/api/models`);
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
  });

  test("rejects a wrong token", async () => {
    const res = await fetch(`${guarded.url}/api/models`, {
      headers: { authorization: `Bearer ${"x".repeat(32)}` },
    });
    expect(res.status).toBe(401);
  });

  test("accepts a bearer token", async () => {
    const res = await fetch(`${guarded.url}/api/models`, {
      headers: { authorization: `Bearer ${"s".repeat(32)}` },
    });
    expect(res.status).toBe(200);
  });

  test("a ?token= visit sets a cookie and redirects the token out of the URL", async () => {
    const res = await fetch(`${guarded.url}/?token=${"s".repeat(32)}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`llamactl_web=${"s".repeat(32)}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
  });

  test("accepts the cookie the redirect set", async () => {
    const res = await fetch(`${guarded.url}/api/models`, {
      headers: { cookie: `llamactl_web=${"s".repeat(32)}` },
    });
    expect(res.status).toBe(200);
  });

  test("refuses to bind off-loopback without a token", async () => {
    await expect(
      startWebServer({
        host: "0.0.0.0",
        port: await findFreePort(49800),
        token: null,
        connect: async () => ({ controlUrl: upstream.url, token: upstream.token, pid: process.pid }),
      }),
    ).rejects.toThrow(/refusing to bind/);
  });
});
