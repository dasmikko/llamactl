/**
 * The llama.cpp build pipeline: clone → configure → build. It runs commands
 * through an injectable {@link BuildRunner} seam so tests can drive the whole
 * flow without real git/cmake. Each step reports progress via `onStatus`/`onLine`
 * callbacks so the InstallManager can mirror it onto a BuildJob record.
 *
 * We keep the whole build tree and run `llama-server` in place from `build/bin`,
 * where CMake already wired its rpath to find every shared library it links
 * (libggml*, libllama, libllama-common, …). An `$ORIGIN`-relative rpath is also
 * requested so the entire install directory stays relocatable as a unit.
 */

import { chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { BuildStatus, LlamaBackend } from "../types.ts";
import { LlamactlError } from "../errors.ts";

/** Default git repo built when a build request omits one (upstream llama.cpp). */
export const DEFAULT_LLAMA_REPO = "https://github.com/ggml-org/llama.cpp";

/**
 * Recognize a GitHub pull-request ref and normalize it to `pull/<N>/head`.
 * Accepts `pull/123/head`, `pr/123`, or `#123`; returns null for ordinary refs.
 */
export function parsePullRef(ref: string): string | null {
  const r = ref.trim();
  if (/^pull\/\d+\/head$/.test(r)) return r;
  const m = /^pr\/(\d+)$/i.exec(r) ?? /^#(\d+)$/.exec(r);
  return m ? `pull/${m[1]}/head` : null;
}

/** Whether `dir` contains a git checkout (has a `.git` entry). */
async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** Thrown when a build is aborted via its signal; mapped to status "canceled". */
export class BuildCanceledError extends Error {
  constructor() {
    super("build canceled");
    this.name = "BuildCanceledError";
  }
}

/** Seam for running external commands and resolving tools, injectable for tests. */
export interface BuildRunner {
  /**
   * Run a command; stream combined stdout+stderr lines to `onLine`. Resolve with
   * the process exit code. Respect `signal` for cooperative cancellation.
   */
  run(
    cmd: string[],
    opts: {
      cwd?: string;
      onLine?: (line: string) => void;
      signal?: AbortSignal;
      /** Extra environment variables merged over the process env. */
      env?: Record<string, string>;
    },
  ): Promise<number>;
  /** Resolve a tool on PATH (like Bun.which); null when absent. */
  which(tool: string): string | null;
}

/** Inputs to a single build run. */
export interface BuildParams {
  repo: string;
  ref: string;
  backend: LlamaBackend;
  /**
   * Pass `-allow-unsupported-compiler` to nvcc (CUDA builds only). Use when the
   * host compiler is newer than the CUDA toolkit officially supports and nvcc
   * aborts with "unsupported GNU version".
   */
  allowUnsupportedCompiler: boolean;
  /**
   * Host C++ compiler nvcc should use (`-DCMAKE_CUDA_HOST_COMPILER`), or null to
   * let CMake pick the default. Set to a supported gcc (e.g. "g++-15") when the
   * default compiler is too new for the CUDA toolkit.
   */
  cudaHostCompiler: string | null;
  /**
   * Incremental rebuild: when the install dir already has a git checkout, fetch
   * the latest code for `ref` and reuse the existing build tree (fast recompile)
   * instead of cloning fresh.
   */
  update: boolean;
  /** `<installsDir>/<id>`; this run creates `src/`, `build/`, `bin/` beneath it. */
  installDir: string;
  runner: BuildRunner;
  signal: AbortSignal;
  onStatus: (s: BuildStatus) => void;
  onLine: (line: string) => void;
}

/** What a successful build yields, folded into a LlamaInstall by the manager. */
export interface BuildResult {
  binPath: string;
  commit: string | null;
  version: string | null;
  sizeBytes: number | null;
}

/** Default runner backed by Bun.spawn + Bun.which. */
export function defaultRunner(): BuildRunner {
  return {
    which(tool: string): string | null {
      return Bun.which(tool);
    },

    async run(cmd, opts): Promise<number> {
      const proc = Bun.spawn(cmd, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdout: "pipe",
        stderr: "pipe",
      });

      const onAbort = () => proc.kill();
      if (opts.signal) {
        if (opts.signal.aborted) proc.kill();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        await Promise.all([
          pumpLines(proc.stdout, opts.onLine),
          pumpLines(proc.stderr, opts.onLine),
        ]);
        return await proc.exited;
      } finally {
        opts.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** Read a byte stream, splitting on newlines and forwarding each line. */
async function pumpLines(
  stream: ReadableStream<Uint8Array> | undefined,
  onLine?: (line: string) => void,
): Promise<void> {
  if (!stream || !onLine) {
    // Still drain the stream so the child isn't blocked on a full pipe.
    if (stream) await stream.cancel().catch(() => {});
    return;
  }
  const decoder = new TextDecoder();
  let buf = "";
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.length > 0) onLine(buf);
}

/** Throw a cancellation sentinel if the build's signal has aborted. */
function checkCanceled(signal: AbortSignal): void {
  if (signal.aborted) throw new BuildCanceledError();
}

/**
 * Probe for the build toolchain. Throws LlamactlError("missing_toolchain") with
 * the list of absent tools so the caller can surface an actionable message.
 */
function probeToolchain(runner: BuildRunner, backend: LlamaBackend): void {
  const missing: string[] = [];
  if (!runner.which("git")) missing.push("git");
  if (!runner.which("cmake")) missing.push("cmake");
  if (!runner.which("ninja") && !runner.which("make")) missing.push("ninja or make");
  if (!runner.which("c++") && !runner.which("g++") && !runner.which("clang++")) {
    missing.push("a C++ compiler (c++, g++, or clang++)");
  }
  if (backend === "cuda" && !runner.which("nvcc")) missing.push("nvcc");

  if (missing.length > 0) {
    throw new LlamactlError("missing_toolchain", `missing build tools: ${missing.join(", ")}`, {
      detail: { missing },
    });
  }
}

/**
 * Run a step, forwarding lines and capturing them too (some steps need the
 * output, e.g. `git rev-parse`). Throws BuildCanceledError if aborted partway.
 */
async function runStep(
  p: BuildParams,
  cmd: string[],
  cwd?: string,
  env?: Record<string, string>,
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await p.runner.run(cmd, {
    cwd,
    env,
    signal: p.signal,
    onLine: (line) => {
      lines.push(line);
      p.onLine(line);
    },
  });
  if (p.signal.aborted) throw new BuildCanceledError();
  return { code, lines };
}

/** Best-effort: the first non-empty line of captured output. */
function firstNonEmpty(lines: string[]): string | null {
  for (const l of lines) {
    const t = l.trim();
    if (t.length > 0) return t;
  }
  return null;
}

/**
 * Parse a version-ish string from `llama-server --version` output. llama.cpp
 * prints a `version: <build> (<commit>)` line; prefer that, else the first
 * non-empty line. Replicated locally (not imported) to avoid coupling to the
 * supervisor's private helper.
 */
function parseVersion(text: string): string | null {
  const tagged = text.match(/^\s*version:\s*(.+?)\s*$/im);
  if (tagged?.[1]) return tagged[1].trim();
  return firstNonEmpty(text.split("\n"));
}

/** Recursively sum the byte size of a directory tree; null on any error. */
async function dirSize(dir: string): Promise<number | null> {
  try {
    let total = 0;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        const sub = await dirSize(full);
        if (sub !== null) total += sub;
      } else if (e.isFile() || e.isSymbolicLink()) {
        try {
          total += (await stat(full)).size;
        } catch {
          /* dangling symlink or race; ignore */
        }
      }
    }
    return total;
  } catch {
    return null;
  }
}

/**
 * Perform a full build into `installDir`, keeping the source + build tree so
 * llama-server runs in place. Cleans up nothing here; the manager discards the
 * dir only on an explicit cancel (a failed build is kept for inspection). Throws:
 *  - LlamactlError("missing_toolchain") when prerequisites are absent,
 *  - BuildCanceledError when the signal aborts,
 *  - LlamactlError("build_failed") on any non-zero step or a missing binary.
 */
export async function runBuild(p: BuildParams): Promise<BuildResult> {
  const src = join(p.installDir, "src");
  const build = join(p.installDir, "build");

  // 1. Prereqs (before any "cloning" status so a missing toolchain is instant).
  probeToolchain(p.runner, p.backend);
  checkCanceled(p.signal);

  await mkdir(p.installDir, { recursive: true });

  // 2. Acquire source.
  p.onStatus("cloning");
  const pullRef = parsePullRef(p.ref);

  if (p.update && (await isGitRepo(src))) {
    // Incremental update: fetch the latest code for the ref and hard-reset onto
    // it, keeping the build tree so the recompile is incremental.
    const refspec = pullRef ?? p.ref;
    p.onLine(`[llamactl] updating: fetching ${refspec}`);
    const fetch = await runStep(p, ["git", "-C", src, "fetch", "--depth", "1", "origin", refspec]);
    if (fetch.code !== 0) {
      throw new LlamactlError("build_failed", `fetching ${refspec} failed (exit ${fetch.code})`, {
        detail: { step: "fetch", code: fetch.code, ref: refspec },
      });
    }
    const reset = await runStep(p, ["git", "-C", src, "reset", "--hard", "FETCH_HEAD"]);
    if (reset.code !== 0) {
      throw new LlamactlError("build_failed", `reset failed (exit ${reset.code})`, {
        detail: { step: "reset", code: reset.code },
      });
    }
  } else if (pullRef) {
    // GitHub PR: the head lives at refs/pull/<N>/head, which isn't a branch and
    // can't be `clone --branch`ed. Shallow-clone the default branch, then fetch
    // and check out the PR head.
    p.onLine(`[llamactl] building from PR ref ${pullRef}`);
    const clone = await runStep(p, ["git", "clone", "--depth", "1", p.repo, src]);
    if (clone.code !== 0) {
      throw new LlamactlError("build_failed", `clone failed (exit ${clone.code})`, {
        detail: { step: "clone", code: clone.code },
      });
    }
    const fetch = await runStep(p, ["git", "-C", src, "fetch", "--depth", "1", "origin", pullRef]);
    if (fetch.code !== 0) {
      throw new LlamactlError("build_failed", `fetching ${pullRef} failed (exit ${fetch.code})`, {
        detail: { step: "fetch", code: fetch.code, ref: pullRef },
      });
    }
    const checkout = await runStep(p, ["git", "-C", src, "checkout", "FETCH_HEAD"]);
    if (checkout.code !== 0) {
      throw new LlamactlError("build_failed", `checkout failed (exit ${checkout.code})`, {
        detail: { step: "checkout", code: checkout.code },
      });
    }
  } else {
    const shallow = await runStep(p, [
      "git",
      "clone",
      "--depth",
      "1",
      "--branch",
      p.ref,
      p.repo,
      src,
    ]);
    if (shallow.code !== 0) {
      // Ref may be a commit sha (not a branch/tag): full clone then checkout.
      await rm(src, { recursive: true, force: true });
      const full = await runStep(p, ["git", "clone", p.repo, src]);
      if (full.code !== 0) {
        throw new LlamactlError("build_failed", `clone failed (exit ${full.code})`, {
          detail: { step: "clone", code: full.code },
        });
      }
      const checkout = await runStep(p, ["git", "-C", src, "checkout", p.ref]);
      if (checkout.code !== 0) {
        throw new LlamactlError("build_failed", `checkout failed (exit ${checkout.code})`, {
          detail: { step: "checkout", code: checkout.code },
        });
      }
    }
  }

  // Resolve the built commit (best-effort; null if it fails).
  let commit: string | null = null;
  const revParse = await runStep(p, ["git", "-C", src, "rev-parse", "HEAD"]);
  if (revParse.code === 0) commit = firstNonEmpty(revParse.lines);

  // When the host gcc is newer than the CUDA toolkit officially supports, nvcc
  // aborts with "unsupported GNU version". `-allow-unsupported-compiler`
  // overrides that check. We deliver it two ways so it reaches nvcc no matter
  // how ggml/CMake thread their flags: via CMAKE_CUDA_FLAGS, and via the
  // NVCC_PREPEND_FLAGS env var (honored by every nvcc invocation).
  const allowUnsupported = p.backend === "cuda" && p.allowUnsupportedCompiler;
  const cudaEnv: Record<string, string> | undefined = allowUnsupported
    ? { NVCC_PREPEND_FLAGS: `-allow-unsupported-compiler ${process.env.NVCC_PREPEND_FLAGS ?? ""}`.trim() }
    : undefined;
  if (allowUnsupported) {
    // Make the override visible in the build log so it's obvious it took effect
    // (this also passes through CMake's CUDA compiler-detection step).
    p.onLine(`[llamactl] allow-unsupported-compiler ON — NVCC_PREPEND_FLAGS=${cudaEnv!.NVCC_PREPEND_FLAGS}`);
  }

  // 3. Configure.
  p.onStatus("configuring");
  const cudaFlag = p.backend === "cuda" ? "ON" : "OFF";
  const configureArgs = [
    "cmake",
    "-S",
    src,
    "-B",
    build,
    "-DCMAKE_BUILD_TYPE=Release",
    "-DLLAMA_CURL=OFF",
    "-DLLAMA_BUILD_SERVER=ON",
    `-DGGML_CUDA=${cudaFlag}`,
    // Make the build-tree rpath $ORIGIN-relative so the whole install dir can be
    // moved as a unit and llama-server still finds its sibling .so files.
    "-DCMAKE_BUILD_RPATH_USE_ORIGIN=ON",
  ];
  if (allowUnsupported) {
    configureArgs.push("-DCMAKE_CUDA_FLAGS=-allow-unsupported-compiler");
  }
  // Point nvcc at a specific host compiler (used during compiler detection too).
  if (p.backend === "cuda" && p.cudaHostCompiler) {
    configureArgs.push(`-DCMAKE_CUDA_HOST_COMPILER=${p.cudaHostCompiler}`);
    p.onLine(`[llamactl] CUDA host compiler: ${p.cudaHostCompiler}`);
  }
  const configure = await runStep(p, configureArgs, undefined, cudaEnv);
  if (configure.code !== 0) {
    throw new LlamactlError("build_failed", `configure failed (exit ${configure.code})`, {
      detail: { step: "configure", code: configure.code },
    });
  }

  // 4. Build.
  p.onStatus("building");
  const compile = await runStep(
    p,
    ["cmake", "--build", build, "--config", "Release", "-j", "--target", "llama-server"],
    undefined,
    cudaEnv,
  );
  if (compile.code !== 0) {
    throw new LlamactlError("build_failed", `build failed (exit ${compile.code})`, {
      detail: { step: "build", code: compile.code },
    });
  }

  // 5. Locate the in-place binary. We keep the whole build tree and run
  // llama-server straight from build/bin, so its CMake-wired rpath resolves
  // every shared library it links — no copying, no missing libs.
  p.onStatus("installing");
  const binPath = join(build, "bin", "llama-server");
  if (!(await Bun.file(binPath).exists())) {
    throw new LlamactlError("build_failed", "build produced no llama-server binary", {
      detail: { step: "install", binPath },
    });
  }
  await chmod(binPath, 0o755);
  checkCanceled(p.signal);

  // 6. Version probe (best-effort; the real binary is needed, null otherwise).
  let version: string | null = null;
  try {
    const ver = await runStep(p, [binPath, "--version"]);
    if (ver.code === 0) version = parseVersion(ver.lines.join("\n"));
  } catch {
    /* a flaky --version must not fail an otherwise good build */
  }

  // 7. Size (best-effort).
  const sizeBytes = await dirSize(p.installDir);

  return { binPath, commit, version, sizeBytes };
}
