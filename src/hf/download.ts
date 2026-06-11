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

import { mkdir, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
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
  /**
   * Automatic retry attempts on a transient failure (network drop, 5xx, 429)
   * before giving up. Each retry resumes from the partial `.part` file via an
   * HTTP Range request. Default 3. Auth/4xx errors are fatal and never retried.
   */
  maxRetries?: number;
  /** Base backoff between retries (ms); grows linearly per attempt. Default 1000. */
  retryDelayMs?: number;
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
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

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
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 1000;
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

  dismiss(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new LlamactlError("download_not_found", `no download with id "${id}"`, {
        detail: { id },
      });
    }
    // Abort if still in flight, then drop it from the list and queue entirely.
    if (entry.record.status === "downloading") entry.controller.abort();
    const idx = this.queue.indexOf(id);
    if (idx >= 0) this.queue.splice(idx, 1);
    this.entries.delete(id);
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
   * Perform the download for `entry`, retrying transient failures (network
   * drops, 5xx, 429) up to `maxRetries` times and resuming each attempt from the
   * partial `.part` file via an HTTP Range request. Auth/4xx errors are fatal
   * and fail immediately. Any failure is recorded on the record so it never
   * escapes this method. On error the `.part` is KEPT so a later retry resumes;
   * on cancel it is discarded.
   */
  private async run(entry: Entry): Promise<void> {
    const { record, controller } = entry;
    let partPath: string | null = null;

    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await this.attemptDownload(entry);
          partPath = r.partPath;
          await r.finalize();
          break;
        } catch (e) {
          if (isAbortError(e)) throw e;
          if (e instanceof FatalDownloadError) throw e;
          if (attempt >= this.maxRetries) throw e;
          // Transient: back off, then loop — attemptDownload resumes from .part.
          await sleepAbortable(this.retryDelayMs * (attempt + 1), controller.signal);
        }
      }

      record.error = null;
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
      // Keep the .part on failure so a retry can resume from where it stopped.
      this.fail(record, e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * One download attempt. Reads HF metadata (commit + blob etag), then writes
   * into the Hugging Face Hub cache layout — a `blobs/<etag>` file with a
   * `snapshots/<commit>/<file>` symlink and a `refs/<rev>` pointer — shared with
   * llama.cpp and de-duplicated against any already-cached blob. Falls back to a
   * flat `destDir/repo/basename` layout when HF metadata is absent (e.g. tests).
   * Returns the `.part` path (for cleanup) and a `finalize` that renames the
   * completed part into place and writes the symlink/refs. Throws
   * FatalDownloadError on auth/4xx; a plain Error on transient failures.
   */
  private async attemptDownload(
    entry: Entry,
  ): Promise<{ partPath: string | null; finalize: () => Promise<void> }> {
    const { record, controller, revision } = entry;
    const token = await this.getToken();
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

    // Metadata request: don't auto-follow so we can read the Hub headers that
    // huggingface.co sets before redirecting to the (presigned) CDN URL.
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
      await metaRes.body?.cancel().catch(() => {});
      // 5xx/429 are transient (retry); other 4xx are fatal.
      const msg = `HTTP ${metaRes.status}${authHint}`;
      throw isTransientStatus(metaRes.status) ? new Error(msg) : new FatalDownloadError(msg);
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

      const linkAndRefs = async (): Promise<void> => {
        await mkdir(dirname(snapFile), { recursive: true });
        await symlink(relative(dirname(snapFile), blobPath), snapFile).catch((e: unknown) => {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        });
        await mkdir(join(repoDir, "refs"), { recursive: true });
        await writeFile(join(repoDir, "refs", revision), commit);
      };

      if (await Bun.file(blobPath).exists()) {
        // Blob already cached (possibly by llama.cpp) — skip the download.
        record.receivedBytes = record.totalBytes ?? 0;
        await metaRes.body?.cancel().catch(() => {});
        return { partPath: null, finalize: linkAndRefs };
      }

      const partPath = `${blobPath}.part`;
      await mkdir(dirname(blobPath), { recursive: true });
      await this.streamWithResume(metaRes, partPath, record, controller.signal);
      return {
        partPath,
        finalize: async () => {
          await rename(partPath, blobPath);
          await linkAndRefs();
        },
      };
    }

    // ---- Flat fallback (no HF metadata, e.g. a local test server). ----
    const dest = join(this.destDirFn(), record.repo, basename(record.file));
    record.destPath = dest;
    const partPath = `${dest}.part`;
    await mkdir(dirname(dest), { recursive: true });
    await this.streamWithResume(metaRes, partPath, record, controller.signal);
    return { partPath, finalize: () => rename(partPath, dest) };
  }

  /**
   * Resolve the body (following the CDN redirect with a Range header when a
   * partial `.part` exists) and stream it into `tmp`. A 206 appends to the
   * partial; a 200 (Range ignored) or a fresh start truncates and rewrites; a
   * 416 means the part already holds every byte.
   */
  private async streamWithResume(
    metaRes: Response,
    tmp: string,
    record: Download,
    signal: AbortSignal,
  ): Promise<void> {
    const offset = await fileSize(tmp);

    if (metaRes.status >= 300 && metaRes.status < 400) {
      const loc = metaRes.headers.get("location");
      if (!loc) throw new Error(`redirect without a location (HTTP ${metaRes.status})`);
      // The CDN URL is presigned; sending the HF token to it is unnecessary.
      const rangeHeaders: Record<string, string> = offset > 0 ? { Range: `bytes=${offset}-` } : {};
      const bodyRes = await fetch(loc, { headers: rangeHeaders, redirect: "follow", signal });

      if (bodyRes.status === 416) {
        // Requested range past the end ⇒ the part already has all the bytes.
        await bodyRes.body?.cancel().catch(() => {});
        record.receivedBytes = record.totalBytes ?? offset;
        return;
      }
      if (!bodyRes.ok) {
        await bodyRes.body?.cancel().catch(() => {});
        const msg = `HTTP ${bodyRes.status}`;
        throw isTransientStatus(bodyRes.status) ? new Error(msg) : new FatalDownloadError(msg);
      }
      // 206 ⇒ server honored the Range, append; otherwise (200) start fresh.
      const append = offset > 0 && bodyRes.status === 206;
      await this.stream(bodyRes, tmp, record, append);
      assertComplete(record);
      return;
    }

    // Direct response (the meta request already returned the body, e.g. the
    // local test server). No Range was sent, so always start fresh.
    await this.stream(metaRes, tmp, record, false);
    assertComplete(record);
  }

  /**
   * Stream a response body to `tmp`. With `append`, opens in append mode and
   * seeds receivedBytes from the existing partial; otherwise truncates and
   * starts from zero. Updates receivedBytes as chunks arrive.
   */
  private async stream(
    res: Response,
    tmp: string,
    record: Download,
    append: boolean,
  ): Promise<void> {
    const body = res.body;
    if (body === null) throw new Error("empty response body");

    record.receivedBytes = append ? await fileSize(tmp) : 0;
    const out = createWriteStream(tmp, { flags: append ? "a" : "w" });
    try {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          if (!out.write(value)) {
            await new Promise<void>((resolve) => out.once("drain", resolve));
          }
          record.receivedBytes += value.byteLength;
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    } catch (e) {
      // Flush whatever was written so a later resume picks up from the real
      // on-disk offset (don't destroy — that could drop buffered bytes).
      await new Promise<void>((resolve) => out.end(() => resolve()));
      throw e;
    }
  }

  retry(id: string): Download {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new LlamactlError("download_not_found", `no download with id "${id}"`, {
        detail: { id },
      });
    }
    // Only resume a stopped download; a live/finished one is left as-is.
    if (entry.record.status === "error" || entry.record.status === "canceled") {
      entry.controller = new AbortController();
      entry.record.status = "downloading";
      entry.record.error = null;
      this.enqueue(entry);
    }
    return entry.record;
  }

  /** Record an error outcome on a download. */
  private fail(record: Download, message: string): void {
    record.status = "error";
    record.error = message;
  }
}

/** A non-retryable download failure (auth / 4xx) — fails the download at once. */
class FatalDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalDownloadError";
  }
}

/** 5xx and 429 are worth retrying; other statuses are not. */
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Guard against a silently truncated transfer: a dropped connection can look
 * like a clean EOF to the reader, leaving fewer bytes than advertised. Treat a
 * short read as a transient failure so the caller retries and resumes.
 */
function assertComplete(record: Download): void {
  if (record.totalBytes != null && record.receivedBytes < record.totalBytes) {
    throw new Error(
      `incomplete transfer: ${record.receivedBytes} of ${record.totalBytes} bytes`,
    );
  }
}

/** Current size of a file in bytes, or 0 if it doesn't exist. */
async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** Sleep that rejects with an AbortError if the signal fires first. */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(makeAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(makeAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function makeAbortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

/** Whether a thrown value is a fetch/stream AbortError. */
function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}
