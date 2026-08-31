/**
 * Unit tests for the TUI chat client: the incremental SSE parser and the
 * streaming chat call (against the fake llama-server, which speaks real SSE).
 */

import { test, expect } from "bun:test";
import { SseParser, streamChat, fetchModelName, type ChatMessage } from "../src/tui/chat.ts";
import { startFakeServer } from "./helpers/fake-llama-server.ts";

// --- SseParser -------------------------------------------------------------

test("SseParser: complete events in one chunk", () => {
  const p = new SseParser();
  expect(p.push('data: {"a":1}\n\ndata: {"b":2}\n\n')).toEqual(['{"a":1}', '{"b":2}']);
});

test("SseParser: events split across chunk boundaries", () => {
  const p = new SseParser();
  expect(p.push('data: {"hel')).toEqual([]);
  expect(p.push('lo":1}\n')).toEqual(['{"hello":1}']);
  // A split inside the "data:" prefix itself.
  expect(p.push('da')).toEqual([]);
  expect(p.push('ta: {"x":9}\n')).toEqual(['{"x":9}']);
});

test("SseParser: CRLF, comments, event lines, and [DONE]", () => {
  const p = new SseParser();
  const out = p.push(
    ": keep-alive\r\nevent: message\r\ndata: [DONE]\r\ndata: {\"ok\":true}\r\n\r\n",
  );
  expect(out).toEqual(['{"ok":true}']);
});

test("SseParser: trailing partial line is held for the next push", () => {
  const p = new SseParser();
  expect(p.push('data: {"a":1}\ndata: {"b":2')).toEqual(['{"a":1}']);
  expect(p.push('}\n')).toEqual(['{"b":2}']);
});

// --- streamChat ------------------------------------------------------------

const NOOP = { onDelta: () => {} } as const;

test("streamChat: accumulates content deltas from the fake server", async () => {
  const fake = startFakeServer({ model: "fake-model" });
  try {
    const deltas: string[] = [];
    const messages: ChatMessage[] = [{ role: "user", text: "hi" }];
    await streamChat({
      baseUrl: fake.url,
      model: "fake-model",
      messages,
      signal: new AbortController().signal,
      onDelta: (d) => deltas.push(d),
    });
    // The fake server streams "hello" + " world" + [DONE].
    expect(deltas.join("")).toBe("hello world");
  } finally {
    fake.stop();
  }
});

test("streamChat: rejects with the server's error detail on HTTP failure", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ error: { message: "boom" } }, { status: 500 }),
  });
  try {
    await expect(
      streamChat({
        baseUrl: `http://127.0.0.1:${server.port}`,
        model: "m",
        messages: [],
        signal: new AbortController().signal,
        ...NOOP,
      }),
    ).rejects.toThrow("HTTP 500: boom");
  } finally {
    server.stop(true);
  }
});

test("streamChat: an aborted signal stops the stream", async () => {
  const fake = startFakeServer();
  try {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      streamChat({
        baseUrl: fake.url,
        model: "m",
        messages: [],
        signal: ctrl.signal,
        ...NOOP,
      }),
    ).rejects.toThrow();
    expect(ctrl.signal.aborted).toBe(true);
  } finally {
    fake.stop();
  }
});

test("streamChat: skips malformed frames and null deltas", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      new Response(
        "data: not-json\n\ndata: {\"choices\":[{\"delta\":{\"content\":null}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  try {
    const deltas: string[] = [];
    await streamChat({
      baseUrl: `http://127.0.0.1:${server.port}`,
      model: "m",
      messages: [],
      signal: new AbortController().signal,
      onDelta: (d) => deltas.push(d),
    });
    expect(deltas).toEqual(["ok"]);
  } finally {
    server.stop(true);
  }
});

test("streamChat: sends OpenAI wire format ({ role, content }, not text)", async () => {
  let seen: unknown = null;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      seen = await req.json();
      return new Response(
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    await streamChat({
      baseUrl: `http://127.0.0.1:${server.port}`,
      model: "m",
      messages: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi" },
        { role: "user", text: "again" },
      ],
      signal: new AbortController().signal,
      ...NOOP,
    });
    const body = seen as { messages?: { role?: string; content?: string; text?: string }[] };
    expect(body.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" },
    ]);
    for (const m of body.messages ?? []) expect(m.text).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

// --- fetchModelName ---------------------------------------------------------

test("fetchModelName: reads the served model id", async () => {
  const fake = startFakeServer({ model: "served-model" });
  try {
    expect(await fetchModelName(fake.url, "fallback")).toBe("served-model");
  } finally {
    fake.stop();
  }
});

test("fetchModelName: falls back when the endpoint is unreachable", async () => {
  // Port 1 is almost certainly closed.
  expect(await fetchModelName("http://127.0.0.1:1", "fallback")).toBe("fallback");
});
