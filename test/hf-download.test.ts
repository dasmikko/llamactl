/**
 * Integration tests for the background DownloadManager. A local `Bun.serve` on
 * an ephemeral port stands in for the Hugging Face Hub; the manager is pointed
 * at it through the `urlFor` seam so nothing touches the network. Downloads land
 * in a fresh `mkdtemp` directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DownloadManager } from "../src/hf/download.ts";
import { isLlamactlError } from "../src/errors.ts";

/** Poll `cond` until true or the timeout elapses. */
async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met within timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("DownloadManager", () => {
  let destDir: string;

  beforeEach(async () => {
    destDir = await mkdtemp(join(tmpdir(), "llamactl-dl-"));
  });

  afterEach(async () => {
    await rm(destDir, { recursive: true, force: true });
  });

  test("downloads a file to destDir/repo/basename with correct bytes", async () => {
    const body = new TextEncoder().encode("hello gguf world".repeat(64));
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(body, {
          headers: { "content-length": String(body.byteLength) },
        });
      },
    });

    try {
      const mgr = new DownloadManager({
        destDir: () => destDir,
        getToken: () => null,
        urlFor: () => `http://127.0.0.1:${server.port}/file`,
      });

      const rec = mgr.start("org/repo", "weights/model.Q4_K_M.gguf");
      expect(rec.status).toBe("downloading");
      expect(rec.destPath).toBe(join(destDir, "org/repo", "model.Q4_K_M.gguf"));

      await until(() => mgr.get(rec.id)?.status !== "downloading");

      const final = mgr.get(rec.id);
      expect(final?.status).toBe("done");
      expect(final?.error).toBeNull();
      expect(final?.totalBytes).toBe(body.byteLength);
      expect(final?.receivedBytes).toBe(body.byteLength);
      expect(final?.receivedBytes).toBe(final?.totalBytes as number);

      const written = await readFile(join(destDir, "org/repo", "model.Q4_K_M.gguf"));
      expect(written.byteLength).toBe(body.byteLength);
      expect(new Uint8Array(written)).toEqual(body);
    } finally {
      server.stop(true);
    }
  });

  test("writes the HF Hub cache layout when metadata headers are present", async () => {
    const body = new TextEncoder().encode("gguf-cache-bytes");
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const etag = "ab".repeat(32); // 64-hex sha256-like blob hash
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(body, {
          headers: {
            "content-length": String(body.byteLength),
            "x-repo-commit": commit,
            "x-linked-etag": `"${etag}"`,
            "x-linked-size": String(body.byteLength),
          },
        });
      },
    });
    try {
      const mgr = new DownloadManager({
        destDir: () => destDir,
        getToken: () => null,
        urlFor: () => `http://127.0.0.1:${server.port}/f`,
      });
      const rec = mgr.start("org/Name", "model.gguf");
      await until(() => mgr.get(rec.id)?.status === "done", 3000);

      const repoDir = join(destDir, "models--org--Name");
      const blob = join(repoDir, "blobs", etag);
      const snap = join(repoDir, "snapshots", commit, "model.gguf");

      expect(await Bun.file(blob).exists()).toBe(true);
      expect(mgr.get(rec.id)?.destPath).toBe(snap);
      // The snapshot path is a symlink resolving to the blob content.
      expect(new Uint8Array(await readFile(snap))).toEqual(body);
      // refs/main points at the commit.
      expect((await readFile(join(repoDir, "refs", "main"), "utf8")).trim()).toBe(commit);
    } finally {
      server.stop(true);
    }
  });

  test("fires onComplete and auto-clears the finished entry", async () => {
    const body = new TextEncoder().encode("done!");
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(body, { headers: { "content-length": String(body.byteLength) } });
      },
    });
    try {
      const completedIds: string[] = [];
      const mgr = new DownloadManager({
        destDir: () => destDir,
        getToken: () => null,
        urlFor: () => `http://127.0.0.1:${server.port}/file`,
        onComplete: (d) => {
          completedIds.push(d.id);
        },
        clearAfterMs: 80,
      });

      const rec = mgr.start("org/repo", "m.gguf");
      await until(() => mgr.get(rec.id)?.status === "done");
      expect(completedIds).toContain(rec.id); // onComplete fired with the finished download

      // The finished entry is dropped from list() after the grace period.
      await until(() => mgr.get(rec.id) === undefined, 2000);
      expect(mgr.list()).toHaveLength(0);
    } finally {
      server.stop(true);
    }
  });

  test("is idempotent per repo+file while in flight", async () => {
    // A never-ending body keeps the first download active.
    const server = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(16));
            // never close
          },
        });
        return new Response(stream);
      },
    });
    try {
      const mgr = new DownloadManager({
        destDir: () => destDir,
        getToken: () => null,
        urlFor: () => `http://127.0.0.1:${server.port}/file`,
      });
      const a = mgr.start("org/repo", "m.gguf");
      const b = mgr.start("org/repo", "m.gguf");
      expect(b).toBe(a); // same record returned, no second download
      expect(mgr.list().length).toBe(1);
      mgr.cancel(a.id);
    } finally {
      server.stop(true);
    }
  });

  test("cancel aborts an in-flight download → status canceled, no throw", async () => {
    let pushed = false;
    const server = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            // Emit one chunk, then stall indefinitely.
            controller.enqueue(new Uint8Array(8));
            pushed = true;
            await new Promise(() => {}); // never resolves
          },
        });
        // No content-length: an unbounded stream.
        return new Response(stream);
      },
    });

    try {
      const mgr = new DownloadManager({
        destDir: () => destDir,
        getToken: () => null,
        urlFor: () => `http://127.0.0.1:${server.port}/slow`,
      });

      const rec = mgr.start("org/repo", "slow.gguf");
      // Wait until the first chunk has been served (download is genuinely active).
      await until(() => pushed && (mgr.get(rec.id)?.receivedBytes ?? 0) > 0);

      mgr.cancel(rec.id);

      await until(() => mgr.get(rec.id)?.status === "canceled");
      expect(mgr.get(rec.id)?.status).toBe("canceled");
    } finally {
      server.stop(true);
    }
  });

  test("cancel on an unknown id throws download_not_found", () => {
    const mgr = new DownloadManager({ destDir: () => destDir, getToken: () => null });
    try {
      mgr.cancel("nope:nope");
      throw new Error("expected cancel to throw");
    } catch (e) {
      expect(isLlamactlError(e)).toBe(true);
      if (isLlamactlError(e)) expect(e.code).toBe("download_not_found");
    }
  });

  test("non-OK HTTP response yields status error", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("forbidden", { status: 403 });
      },
    });
    try {
      const mgr = new DownloadManager({
        destDir: () => destDir,
        getToken: () => null,
        urlFor: () => `http://127.0.0.1:${server.port}/gated`,
      });
      const rec = mgr.start("org/gated", "m.gguf");
      await until(() => mgr.get(rec.id)?.status !== "downloading");
      const final = mgr.get(rec.id);
      expect(final?.status).toBe("error");
      expect(final?.error).toContain("403");
    } finally {
      server.stop(true);
    }
  });
});
