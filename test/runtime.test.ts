import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  generateToken,
  writeRuntime,
  readRuntime,
  isProcessAlive,
  readLiveRuntime,
  clearRuntime,
  constantTimeEqual,
} from "../src/daemon/runtime.ts";
import { runtimePath } from "../src/config/paths.ts";
import type { Runtime } from "../src/types.ts";

let tmpDir: string;
let prevXdgState: string | undefined;

beforeAll(async () => {
  prevXdgState = process.env.XDG_STATE_HOME;
  tmpDir = await mkdtemp(join(tmpdir(), "bunstash-runtime-"));
  process.env.XDG_STATE_HOME = tmpDir;
});

afterAll(async () => {
  if (prevXdgState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = prevXdgState;
  await rm(tmpDir, { recursive: true, force: true });
});

function sampleRuntime(pid: number): Runtime {
  return {
    controlUrl: "http://127.0.0.1:48134",
    proxyUrl: "http://127.0.0.1:11435",
    token: generateToken(),
    pid,
    startedAt: Date.now(),
  };
}

describe("generateToken", () => {
  test("returns 64 lowercase hex chars", () => {
    const t = generateToken();
    expect(t).toHaveLength(64);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  test("two calls differ", () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe("writeRuntime / readRuntime", () => {
  test("round-trips a Runtime", async () => {
    const rt = sampleRuntime(process.pid);
    await writeRuntime(rt);
    const read = await readRuntime();
    expect(read).toEqual(rt);
  });

  test("file mode is 0600 on non-Windows", async () => {
    if (process.platform === "win32") return;
    await writeRuntime(sampleRuntime(process.pid));
    const mode = statSync(runtimePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("readRuntime returns null on malformed JSON", async () => {
    await Bun.write(runtimePath(), "{ not json");
    expect(await readRuntime()).toBeNull();
  });
});

describe("isProcessAlive", () => {
  test("true for current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("false for an unused pid", () => {
    expect(isProcessAlive(0x3fffffff)).toBe(false);
  });
});

describe("readLiveRuntime", () => {
  test("returns the runtime when pid is alive", async () => {
    const rt = sampleRuntime(process.pid);
    await writeRuntime(rt);
    expect(await readLiveRuntime()).toEqual(rt);
  });

  test("returns null when pid is dead (stale)", async () => {
    await writeRuntime(sampleRuntime(0x3fffffff));
    expect(await readLiveRuntime()).toBeNull();
  });
});

describe("clearRuntime", () => {
  test("removes the file and is idempotent", async () => {
    await writeRuntime(sampleRuntime(process.pid));
    await clearRuntime();
    expect(await readRuntime()).toBeNull();
    // ENOENT is ignored on a second call.
    await clearRuntime();
    expect(await readRuntime()).toBeNull();
  });
});

describe("constantTimeEqual", () => {
  test("equal strings → true", () => {
    expect(constantTimeEqual("abcdef", "abcdef")).toBe(true);
  });

  test("same length, different → false", () => {
    expect(constantTimeEqual("abcdef", "abcdeg")).toBe(false);
  });

  test("different length → false", () => {
    expect(constantTimeEqual("abc", "abcdef")).toBe(false);
  });
});
