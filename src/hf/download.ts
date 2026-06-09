/**
 * Background model download manager. Streams a file from the Hugging Face Hub
 * to `${destDir()}/${repo}/${basename(file)}`, writing to a `.part` temp file
 * and atomically renaming on completion. Downloads run in the background;
 * `start()` returns the tracked `Download` record immediately and is idempotent
 * per repo+file. Concurrency is capped with a tiny FIFO queue; cancellation is
 * cooperative via a per-download `AbortController`.
 *
 * The download manager talks to the supervisor/control-plane only through the
 * frozen `IDownloadManager` seam in `../types.ts`.
 */

import { mkdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import type { Download, IDownloadManager } from "../types.ts";
import { LlamactlError } from "../errors.ts";
import { fileUrl } from "./client.ts";
import { cleanEtag, repoCacheDir } from "./cache.ts";

export interface DownloadManagerOptions {
  /** Base download directory; a model lands at `${destDir()}/${repo}/${basename(file)}`. */
  destDir: () => string;
  /** Resolve the Hugging Face token (sync or async) for authenticated fetches. */
  getToken: () => Promise<string | null> | string | null;
  /** Max concurrent active downloads. Default 2. */
  concurrency?: number;
  /**
   * Seam for building the download URL. Defaults to `fileUrl` (huggingface.co);
   * tests override it to point at a local server.
   */
  urlFor?: (repo: string, file: string, revision: string) => string;
  /** Invoked when a download finishes successfully (e.g. to re-run discovery). */
  onComplete?: (download: Download) => void;
  /**
   * How long a finished (done/canceled) download lingers in `list()` before it
   * is dropped, so the UI doesn't keep a completed entry pinned forever. Default
   * 6000 ms. Errors are kept so failures stay visible.
   */
  clearAfterMs?: number;
}

/** Internal bookkeeping for one tracked download. */
interface Entry {
  /** The user-facing snapshot, mutated in place as the download progresses. */
  record: Download;
  /** Aborts the in-flight fetch when the download is canceled. */
  controller: AbortController;
  /** The revision to fetch (carried from start → queued run). */
  revision: string;
}

export class DownloadManager implements IDownloadManager {
  private readonly destDirFn: () => string;
  private readonly getToken: () => Promise<string | null> | string | null;
  private readonly concurrency: number;
  private readonly urlFor: (repo: string, file: string, revision: string) => string;
  private readonly onComplete?: (download: Download) => void;
  private readonly clearAfterMs: number;

  /** All downloads ever seen, keyed by deterministic id. */
  private readonly entries = new Map<string, Entry>();
  /** FIFO queue of ids waiting for a free concurrency slot. */
  private readonly queue: string[] = [];
  /** Number of downloads currently fetching. */
  private active = 0;
  /** Ids that currently hold a concurrency slot (are mid-fetch). */
  private readonly activeIds = new Set<string>();

  constructor(opts: DownloadManagerOptions) {
    this.destDirFn = opts.destDir;
    this.getToken = opts.getToken;
    this.concurrency = opts.concurrency ?? 2;
    this.urlFor = opts.urlFor ?? fileUrl;
    this.onComplete = opts.onComplete;
    this.clearAfterMs = opts.clearAfterMs ?? 6000;
  }

  /** Drop a finished entry from the list after the configured grace period. */
  private scheduleRemoval(id: string): void {
    if (this.clearAfterMs <= 0) return;
    setTimeout(() => {
      const e = this.entries.get(id);
      if (e && e.record.status !== "downloading") this.entries.delete(id);
    }, this.clearAfterMs);
  }

  list(): Download[] {
    // Most-recent first.
    return [...this.entries.values()]
      .map((e) => e.record)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): Download | undefined {
    return this.entries.get(id)?.record;
  }

  start(repo: string, file: string, revision = "main"): Download {
    const id = `${repo}:${file}`;
    const existing = this.entries.get(id);
    // Idempotent: an in-flight download for the same target is returned as-is.
    if (existing && existing.record.status === "downloading") {
      return existing.record;
    }

    const record: Download = {
      id,
      repo,
      file,
      destPath: join(this.destDirFn(), repo, basename(file)),
      receivedBytes: 0,
      totalBytes: null,
      status: "downloading",
      error: null,
      startedAt: Date.now(),
    };
    const entry: Entry = { record, controller: new AbortController(), revision };
    this.entries.set(id, entry);
    this.enqueue(entry);
    return record;
  }

  cancel(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new LlamactlError("download_not_found", `no download with id "${id}"`, {
        detail: { id },
      });
    }
    // Aborting unblocks #run, whose catch flips the status to "canceled".
    entry.controller.abort();
    // A still-queued (not yet started) download will never run; mark it now.
    if (entry.record.status === "downloading" && !this.isActive(id)) {
      const idx = this.queue.indexOf(id);
      if (idx >= 0) {
        this.queue.splice(idx, 1);
        entry.record.status = "canceled";
      }
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ----------------------------------------------------------------------- */

  /** Whether `id` currently holds a concurrency slot (is mid-fetch). */
  private isActive(id: string): boolean {
    return this.activeIds.has(id);
  }

  /** Enqueue a run and pump the queue if a slot is free. */
  private enqueue(entry: Entry): void {
    this.queue.push(entry.record.id);
    this.pump();
  }

  /** Start as many queued runs as the concurrency cap allows. */
  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift();
      if (id === undefined) break;
      const entry = this.entries.get(id);
      if (!entry) continue;
      // Skip downloads canceled while queued.
      if (entry.record.status !== "downloading") continue;
      this.active += 1;
      this.activeIds.add(id);
      // Fire-and-forget; #run is wrapped so failures never escape.
      void this.run(entry).finally(() => {
        this.active -= 1;
        this.activeIds.delete(id);
        this.pump();
      });
    }
  }

  /**
   * Perform the download for `entry`. Reads HF metadata (commit + blob etag),
   * then writes into the Hugging Face Hub cache layout — a `blobs/<etag>` file
   * with a `snapshots/<commit>/<file>` symlink and a `refs/<rev>` pointer — so
   * the result is shared with llama.cpp and de-duplicated against any blob that
   * is already cached. Falls back to a flat `destDir/repo/basename` layout when
   * HF metadata is unavailable (e.g. in tests). Any failure is caught and
   * recorded on the record so it never escapes this method.
   */
  private async run(entry: Entry): Promise<void> {
    const { record, controller, revision } = entry;
    let partPath: string | null = null;

    try {
      const token = await this.getToken();
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

      // Metadata request: don't auto-follow so we can read the Hub headers that
      // huggingface.co sets before redirecting to the CDN.
      const metaRes = await fetch(this.urlFor(record.repo, record.file, revision), {
        headers,
        redirect: "manual",
        signal: controller.signal,
      });

      if (metaRes.status >= 400) {
        const authHint =
          metaRes.status === 401 || metaRes.status === 403
            ? " (a Hugging Face token may be required for this gated/private repo)"
            : "";
        this.fail(record, `HTTP ${metaRes.status}${authHint}`);
        return;
      }

      const commit = metaRes.headers.get("x-repo-commit");
      const etag = cleanEtag(metaRes.headers.get("x-linked-etag") ?? metaRes.headers.get("etag"));
      const sizeHeader = metaRes.headers.get("x-linked-size") ?? metaRes.headers.get("content-length");
      if (sizeHeader !== null) {
        const total = Number.parseInt(sizeHeader, 10);
        if (Number.isFinite(total) && total >= 0) record.totalBytes = total;
      }

      if (commit && etag) {
        // ---- Hugging Face Hub cache layout (shared with llama.cpp). ----
        const repoDir = repoCacheDir(this.destDirFn(), record.repo);
        const blobPath = join(repoDir, "blobs", etag);
        const snapFile = join(repoDir, "snapshots", commit, record.file);
        record.destPath = snapFile;

        if (await Bun.file(blobPath).exists()) {
          // Blob already cached (possibly by llama.cpp) — skip the download.
          record.receivedBytes = record.totalBytes ?? 0;
          await metaRes.body?.cancel().catch(() => {});
        } else {
          const bodyRes = await this.resolveBody(metaRes, controller.signal);
          if (!bodyRes.ok) {
            this.fail(record, `HTTP ${bodyRes.status}`);
            return;
          }
          partPath = `${blobPath}.part`;
          await mkdir(dirname(blobPath), { recursive: true });
          await this.stream(bodyRes, partPath, record);
          await rename(partPath, blobPath);
          partPath = null;
        }

        // snapshot symlink (relative, like huggingface_hub) + refs pointer.
        await mkdir(dirname(snapFile), { recursive: true });
        await symlink(relative(dirname(snapFile), blobPath), snapFile).catch((e: unknown) => {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        });
        await mkdir(join(repoDir, "refs"), { recursive: true });
        await writeFile(join(repoDir, "refs", revision), commit);
      } else {
        // ---- Flat fallback (no HF metadata, e.g. a local test server). ----
        const dest = join(this.destDirFn(), record.repo, basename(record.file));
        record.destPath = dest;
        const bodyRes = await this.resolveBody(metaRes, controller.signal);
        if (!bodyRes.ok) {
          this.fail(record, `HTTP ${bodyRes.status}`);
          return;
        }
        partPath = `${dest}.part`;
        await mkdir(dirname(dest), { recursive: true });
        await this.stream(bodyRes, partPath, record);
        await rename(partPath, dest);
        partPath = null;
      }

      record.status = "done";
      // Let the daemon re-discover so the new model appears, then clear the
      // finished entry so it doesn't stay pinned in the UI.
      try {
        this.onComplete?.(record);
      } catch {
        /* a discovery hook error must not break the download */
      }
      this.scheduleRemoval(record.id);
    } catch (e) {
      if (isAbortError(e)) {
        record.status = "canceled";
        if (partPath) await unlink(partPath).catch(() => {});
        this.scheduleRemoval(record.id);
        return;
      }
      this.fail(record, e instanceof Error ? e.message : String(e));
      if (partPath) await unlink(partPath).catch(() => {});
    }
  }

  /** Follow a metadata redirect to the CDN (without auth), or return the response. */
  private async resolveBody(metaRes: Response, signal: AbortSignal): Promise<Response> {
    if (metaRes.status >= 300 && metaRes.status < 400) {
      const loc = metaRes.headers.get("location");
      if (!loc) throw new Error(`redirect without a location (HTTP ${metaRes.status})`);
      // The CDN URL is presigned; sending the HF token to it is unnecessary.
      return fetch(loc, { redirect: "follow", signal });
    }
    return metaRes;
  }

  /** Stream a response body to `tmp`, updating receivedBytes; closes the sink. */
  private async stream(res: Response, tmp: string, record: Download): Promise<void> {
    const body = res.body;
    if (body === null) throw new Error("empty response body");
    const sink = Bun.file(tmp).writer();
    try {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          sink.write(value);
          record.receivedBytes += value.byteLength;
        }
      }
      await sink.end();
    } catch (e) {
      try {
        await sink.end();
      } catch {
        /* ignore */
      }
      throw e;
    }
  }

  /** Record an error outcome on a download. */
  private fail(record: Download, message: string): void {
    record.status = "error";
    record.error = message;
  }
}

/** Whether a thrown value is a fetch/stream AbortError. */
function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}
