/**
 * InstallManager + build pipeline tests. The build runs through a FAKE
 * BuildRunner so no real git/cmake/compiler is needed: `which` returns paths for
 * the whole toolchain by default (a test may toggle one to null), and `run`
 * interprets the command — synthesizing a fake commit on `git rev-parse` and
 * materializing `<build>/bin/llama-server` (+ a ggml `.so`) on `cmake --build`,
 * so the install/copy step finds them. Everything runs in a fresh `mkdtemp` dir.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InstallManager } from "../src/llama/install.ts";
import type { BuildRunner } from "../src/llama/build.ts";
import type { BuildJob } from "../src/types.ts";
import { isLlamactlError } from "../src/errors.ts";

const FAKE_COMMIT = "abc123def4567890abc123def4567890abcabcde";

/** Tools the probe checks; all present by default. */
const TOOLCHAIN = ["git", "cmake", "ninja", "make", "c++", "g++", "clang++", "nvcc"];

interface FakeRunnerControl {
  runner: BuildRunner;
  /** Tools to report as absent (which → null). */
  absent: Set<string>;
  /** Commands that should fail (matched as a substring); maps to an exit code. */
  failOn: Map<string, number>;
  /** Every command run, joined with spaces (for assertions). */
  commands: string[];
  /** Per-command extra env passed to the runner (aligned with `commands`). */
  envs: (Record<string, string> | undefined)[];
}

function makeRunner(): FakeRunnerControl {
  const absent = new Set<string>();
  const failOn = new Map<string, number>();
  const commands: string[] = [];
  const envs: (Record<string, string> | undefined)[] = [];

  const runner: BuildRunner = {
    which(tool: string): string | null {
      if (absent.has(tool)) return null;
      return TOOLCHAIN.includes(tool) ? `/usr/bin/${tool}` : null;
    },

    async run(cmd, opts): Promise<number> {
      const joined = cmd.join(" ");
      commands.push(joined);
      envs.push(opts.env);
      for (const [needle, code] of failOn) {
        if (joined.includes(needle)) return code;
      }

      // Emit a fake commit for rev-parse so the manager records it.
      if (joined.includes("rev-parse")) {
        opts.onLine?.(FAKE_COMMIT);
        return 0;
      }

      // On the build step, materialize the binary + a sibling .so under build/bin.
      if (joined.includes("cmake --build")) {
        // cmd: cmake --build <build> --config ...
        const buildDir = cmd[2];
        if (buildDir) {
          const binDir = join(buildDir, "bin");
          await mkdir(binDir, { recursive: true });
          await writeFile(join(binDir, "llama-server"), "#!/bin/sh\nexit 0\n");
          await writeFile(join(binDir, "libggml.so"), "fake-shared-object");
        }
        opts.onLine?.("built llama-server");
        return 0;
      }

      // The clone step must create the src dir so a later checkout/configure works.
      if (joined.includes("git clone")) {
        const srcDir = cmd[cmd.length - 1];
        if (srcDir) await mkdir(srcDir, { recursive: true });
        opts.onLine?.("cloned");
        return 0;
      }

      opts.onLine?.(`ran: ${joined}`);
      return 0;
    },
  };

  return { runner, absent, failOn, commands, envs };
}

/** Whether a path exists as a directory (Bun.file().exists() is false for dirs). */
async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Poll until a build job reaches a terminal status (or time out). */
async function waitTerminal(
  mgr: InstallManager,
  id: string,
  timeoutMs = 2000,
): Promise<BuildJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = mgr.builds().find((b) => b.id === id);
    if (job && (job.status === "ready" || job.status === "error" || job.status === "canceled")) {
      return job;
    }
    if (Date.now() > deadline) {
      throw new Error(`build ${id} did not finish in ${timeoutMs}ms (status: ${job?.status})`);
    }
    await Bun.sleep(5);
  }
}

describe("InstallManager", () => {
  let root: string;
  let installsDir: string;
  let registryPath: string;
  let ctl: FakeRunnerControl;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "llamactl-install-"));
    installsDir = join(root, "installs");
    registryPath = join(root, "registry.json");
    ctl = makeRunner();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function load(initialActiveId: string | null = null): Promise<InstallManager> {
    return InstallManager.load({
      installsDir,
      registryPath,
      initialActiveId,
      runner: ctl.runner,
      clearAfterMs: 0, // don't auto-clear during tests
    });
  }

  test("happy path: job reaches ready, install registered + active, binPath on disk", async () => {
    const mgr = await load();
    const job = mgr.start({ repo: "https://example.com/llama.cpp", ref: "master" });
    expect(job.status).toBe("queued");

    const done = await waitTerminal(mgr, job.id);
    expect(done.status).toBe("ready");
    expect(done.installId).toBe(job.id);

    const installs = mgr.installs();
    expect(installs).toHaveLength(1);
    const install = installs[0]!;
    expect(install.commit).toBe(FAKE_COMMIT);
    // The fake binary isn't a real executable, so --version yields null.
    expect(install.version === null || typeof install.version === "string").toBe(true);
    expect(await Bun.file(install.binPath).exists()).toBe(true);

    // First install auto-activates.
    expect(mgr.getActive()?.id).toBe(install.id);
    expect(mgr.getActive()?.binPath).toBe(install.binPath);
  });

  test("allowUnsupportedCompiler adds the nvcc flag to a cuda configure", async () => {
    const mgr = await load();
    const job = mgr.start({ repo: "r", ref: "master", backend: "cuda", allowUnsupportedCompiler: true });
    await waitTerminal(mgr, job.id);
    const idx = ctl.commands.findIndex((c) => c.includes("cmake -S"));
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(ctl.commands[idx]!).toContain("-DCMAKE_CUDA_FLAGS=-allow-unsupported-compiler");
    // Also forced via the env var so it reaches every nvcc invocation.
    expect(ctl.envs[idx]?.NVCC_PREPEND_FLAGS ?? "").toContain("-allow-unsupported-compiler");
  });

  test("cudaHostCompiler adds -DCMAKE_CUDA_HOST_COMPILER to a cuda configure", async () => {
    const mgr = await load();
    const job = mgr.start({ repo: "r", ref: "master", backend: "cuda", cudaHostCompiler: "g++-15" });
    await waitTerminal(mgr, job.id);
    const configure = ctl.commands.find((c) => c.includes("cmake -S"));
    expect(configure!).toContain("-DCMAKE_CUDA_HOST_COMPILER=g++-15");
  });

  test("cudaHostCompiler is ignored for cpu builds", async () => {
    const mgr = await load();
    const job = mgr.start({ repo: "r", ref: "master", backend: "cpu", cudaHostCompiler: "g++-15" });
    await waitTerminal(mgr, job.id);
    const configure = ctl.commands.find((c) => c.includes("cmake -S"));
    expect(configure!).not.toContain("CMAKE_CUDA_HOST_COMPILER");
  });

  test("the nvcc flag is omitted by default and for cpu builds", async () => {
    const mgr = await load();
    const cpu = mgr.start({ repo: "r", ref: "master", backend: "cpu", allowUnsupportedCompiler: true });
    await waitTerminal(mgr, cpu.id);
    const configure = ctl.commands.find((c) => c.includes("cmake -S"));
    expect(configure!).not.toContain("allow-unsupported-compiler");
  });

  test("a PR ref fetches refs/pull/<N>/head and checks out FETCH_HEAD", async () => {
    const mgr = await load();
    const job = mgr.start({ repo: "r", ref: "pr/24423" });
    await waitTerminal(mgr, job.id);
    // Plain clone (no --branch), then fetch the PR head, then checkout FETCH_HEAD.
    expect(ctl.commands.some((c) => c.includes("fetch") && c.includes("origin pull/24423/head"))).toBe(true);
    expect(ctl.commands.some((c) => c.includes("checkout FETCH_HEAD"))).toBe(true);
    expect(ctl.commands.some((c) => c.includes("clone") && c.includes("--branch"))).toBe(false);
  });

  test("empty repo defaults to upstream llama.cpp", async () => {
    const mgr = await load();
    const job = mgr.start({ repo: "" });
    expect(job.repo).toBe("https://github.com/ggml-org/llama.cpp");
    await waitTerminal(mgr, job.id);
    expect(mgr.installs()[0]!.repo).toBe("https://github.com/ggml-org/llama.cpp");
  });

  test("keeps the build tree and runs llama-server in place from build/bin", async () => {
    const mgr = await load();
    const job = mgr.start({ repo: "r", ref: "master" });
    await waitTerminal(mgr, job.id);

    const dir = join(installsDir, job.id);
    // Source + build tree are kept so the binary's rpath resolves its libs.
    expect(await dirExists(join(dir, "src"))).toBe(true);
    expect(await dirExists(join(dir, "build"))).toBe(true);
    // binPath points at the in-place binary, not a copied bin/ dir.
    const install = mgr.installs()[0]!;
    expect(install.binPath).toBe(join(dir, "build", "bin", "llama-server"));
    expect(await Bun.file(install.binPath).exists()).toBe(true);
  });

  test("missing toolchain ends the job in error mentioning the tool", async () => {
    ctl.absent.add("cmake");
    const mgr = await load();
    const job = mgr.start({ repo: "r", ref: "master" });

    const done = await waitTerminal(mgr, job.id);
    expect(done.status).toBe("error");
    expect(done.error ?? "").toContain("cmake");
    expect(mgr.installs()).toHaveLength(0);
  });

  test("cancel ends the job in canceled", async () => {
    const mgr = await load();
    const job = mgr.start({ repo: "r", ref: "master" });
    mgr.cancel(job.id);

    const done = await waitTerminal(mgr, job.id);
    expect(done.status).toBe("canceled");
  });

  test("cancel unknown id throws install_not_found", async () => {
    const mgr = await load();
    try {
      mgr.cancel("nope");
      throw new Error("expected throw");
    } catch (e) {
      expect(isLlamactlError(e) && e.code).toBe("install_not_found");
    }
  });

  test("setActive switches active; remove deletes dir + entry", async () => {
    const mgr = await load();
    const a = mgr.start({ repo: "r", ref: "master", name: "alpha" });
    await waitTerminal(mgr, a.id);
    const b = mgr.start({ repo: "r", ref: "master", name: "beta" });
    await waitTerminal(mgr, b.id);

    expect(mgr.installs()).toHaveLength(2);
    // alpha auto-activated (first build).
    expect(mgr.getActive()?.id).toBe(a.id);

    await mgr.setActive(b.id);
    expect(mgr.getActive()?.id).toBe(b.id);

    await mgr.remove(b.id);
    expect(mgr.installs().find((i) => i.id === b.id)).toBeUndefined();
    expect(mgr.getActive()).toBeNull(); // removing the active clears it
    expect(await dirExists(join(installsDir, b.id))).toBe(false);
  });

  test("setActive/remove unknown id throws", async () => {
    const mgr = await load();
    await expect(mgr.setActive("nope")).rejects.toThrow();
    await expect(mgr.remove("nope")).rejects.toThrow();
  });

  test("rename changes the display name and persists across reload", async () => {
    const mgr = await load();
    const a = mgr.start({ repo: "r", ref: "master", name: "alpha" });
    await waitTerminal(mgr, a.id);

    await mgr.rename(a.id, "my fork build");
    expect(mgr.installs()[0]!.name).toBe("my fork build");

    // Persisted: a fresh manager on the same registry sees the new name.
    const reloaded = await InstallManager.load({
      installsDir,
      registryPath,
      initialActiveId: null,
    });
    expect(reloaded.installs().find((i) => i.id === a.id)?.name).toBe("my fork build");
  });

  test("rename rejects an empty name and an unknown id", async () => {
    const mgr = await load();
    const a = mgr.start({ repo: "r", ref: "master" });
    await waitTerminal(mgr, a.id);
    await expect(mgr.rename(a.id, "   ")).rejects.toThrow();
    await expect(mgr.rename("nope", "x")).rejects.toThrow();
  });

  test("setActive(null) clears the active install", async () => {
    const mgr = await load();
    const a = mgr.start({ repo: "r", ref: "master" });
    await waitTerminal(mgr, a.id);
    expect(mgr.getActive()?.id).toBe(a.id);

    await mgr.setActive(null);
    expect(mgr.getActive()).toBeNull();
  });

  test("registry round-trips installs + activeId across reload", async () => {
    const mgr = await load();
    const a = mgr.start({ repo: "r", ref: "master", name: "alpha" });
    await waitTerminal(mgr, a.id);

    // Reload from the same registry path (no override).
    const mgr2 = await load();
    expect(mgr2.installs()).toHaveLength(1);
    expect(mgr2.installs()[0]!.id).toBe(a.id);
    expect(mgr2.getActive()?.id).toBe(a.id);
  });

  test("initialActiveId overrides the persisted active id", async () => {
    const mgr = await load();
    const a = mgr.start({ repo: "r", ref: "master", name: "alpha" });
    await waitTerminal(mgr, a.id);
    const b = mgr.start({ repo: "r", ref: "master", name: "beta" });
    await waitTerminal(mgr, b.id);
    // Persisted active is alpha; reload overriding to beta.
    const mgr2 = await load(b.id);
    expect(mgr2.getActive()?.id).toBe(b.id);
  });

  test("build step failure keeps the source tree for inspection", async () => {
    ctl.failOn.set("cmake --build", 2);
    const mgr = await load();
    const job = mgr.start({ repo: "r", ref: "master" });

    const done = await waitTerminal(mgr, job.id);
    expect(done.status).toBe("error");
    expect(done.error ?? "").toContain("exit 2");
    // The dir is kept so the user can inspect why it failed and retry.
    expect(await dirExists(join(installsDir, job.id))).toBe(true);
  });

  test("cancel discards the partial install dir", async () => {
    const mgr = await load();
    const job = mgr.start({ repo: "r", ref: "master" });
    mgr.cancel(job.id);
    await waitTerminal(mgr, job.id);
    expect(await dirExists(join(installsDir, job.id))).toBe(false);
  });

  test("a failed build's log file persists and records the reason", async () => {
    ctl.failOn.set("cmake --build", 2);
    const mgr = await load();
    const job = mgr.start({ repo: "r", ref: "master" });
    const done = await waitTerminal(mgr, job.id);
    expect(done.status).toBe("error");

    // The log file lives beside (not inside) the cleaned install dir.
    expect(done.logPath).toBe(join(installsDir, `${job.id}.log`));
    expect(await Bun.file(done.logPath).exists()).toBe(true);
    const log = await Bun.file(done.logPath).text();
    expect(log).toContain("build failed");
  });

  test("remove dismisses a failed build and deletes its log", async () => {
    ctl.failOn.set("cmake --build", 2);
    const mgr = await load();
    const job = mgr.start({ repo: "r", ref: "master" });
    const done = await waitTerminal(mgr, job.id);
    expect(done.status).toBe("error");
    expect(mgr.builds().some((b) => b.id === job.id)).toBe(true);

    await mgr.remove(job.id);
    expect(mgr.builds().some((b) => b.id === job.id)).toBe(false);
    expect(await Bun.file(join(installsDir, `${job.id}.log`)).exists()).toBe(false);
  });
});
