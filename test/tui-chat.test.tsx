/**
 * TUI chat panel tests: mount ChatView against the fake llama-server, type a
 * message, send it, and verify the streamed reply renders; then close with
 * Esc. The fake server speaks real SSE, so this exercises the full
 * parse-and-stream path end to end.
 */

import { test, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import { ChatView } from "../src/tui/Chat.tsx";
import { startFakeServer } from "./helpers/fake-llama-server.ts";
import type { RunningModel } from "../src/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mkRunning(port: number): RunningModel {
  return {
    modelId: "m1",
    name: "Llama-3-8B",
    path: "/m1.gguf",
    pid: 42,
    port,
    status: "ready",
    startedAt: Date.now(),
    restarts: 0,
    logPath: "/tmp/llamactl-test.log",
    spec: { model: "m1" },
  };
}

test("chat: sends a message, renders the streamed reply, Esc closes", async () => {
  const fake = startFakeServer({ model: "fake-model" });
  let closed = false;
  const running = mkRunning(fake.port);
  const { mockInput, renderOnce, flush, waitForFrame } = await testRender(
    () => <ChatView running={running} onClose={() => (closed = true)} />,
    { width: 100, height: 24 },
  );
  try {
    await renderOnce();

    // Type the message and send it.
    await mockInput.typeText("hello there");
    await mockInput.pressEnter();
    await flush();

    // The fake server streams "hello" + " world" — wait until both are on
    // screen (the reply may take a couple of frames to arrive).
    const frame = await waitForFrame((f) => f.includes("hello world"), { maxPasses: 100 });
    expect(frame).toContain("hello there");
    expect(frame).toContain("you");
    expect(frame).toContain("model");

    // Idle now: Esc closes the panel. A lone ESC is buffered by the key
    // parser (~200ms) to distinguish it from escape sequences, so give it a
    // moment before asserting.
    await mockInput.pressEscape();
    await sleep(300);
    await flush();
    expect(closed).toBe(true);
  } finally {
    fake.stop();
  }
});

test("chat: shows the endpoint, hint, and input before any message", async () => {
  const fake = startFakeServer({ model: "fake-model" });
  const running = mkRunning(fake.port);
  const { captureCharFrame, renderOnce } = await testRender(
    () => <ChatView running={running} onClose={() => {}} />,
    { width: 100, height: 24 },
  );
  try {
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("CHAT");
    expect(frame).toContain(`http://127.0.0.1:${fake.port}`);
    expect(frame).toContain("Ask the model anything");
    expect(frame).toContain("> ");
    expect(frame).toContain("Enter send");
  } finally {
    fake.stop();
  }
});
