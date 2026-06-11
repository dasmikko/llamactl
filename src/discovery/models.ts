/**
 * Model discovery: recursively scan known model-cache directories (plus any
 * extra configured paths) for `*.gguf` files and turn them into stable `Model`
 * records. Also resolves user selectors to a single model and watches roots for
 * changes. Pure Bun + Node built-ins — no external dependencies.
 */

import { lstat, readdir, realpath, stat, unlink } from "node:fs/promises";
import { watch } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

import type { Model, ModelResolver, ModelSource } from "../types.ts";
import { defaultModelDirs } from "../config/paths.ts";
import { readGgufMeta } from "./gguf.ts";
import { LlamactlError } from "../errors.ts";

export interface DiscoverOptions {
  extraPaths?: string[];
}

/** Maximum directory recursion depth to avoid pathological / looping trees. */
const MAX_DEPTH = 8;

/**
 * Matches a quantization token anywhere in a filename, case-insensitively.
 * Covers IQ*, Q* (with K/M/S/L variants and Q4_0/Q4_1 style), and float
 * formats. Normalized to uppercase by the caller.
 */
const QUANT_RE = /\b(IQ\d[0-9A-Z_]*|Q\d(?:_[0-9KMSL]+)*|BF16|F16|F32|MXFP4)\b/i;

/** Matches a sharded-gguf suffix: `-00001-of-00003`. */
const SHARD_RE = /-(\d{3,})-of-(\d{3,})$/i;

/** A root directory paired with the source label files under it should get. */
interface Root {
  /** Absolute, resolved path. */
  dir: string;
  source: ModelSource;
}

/** Build the ordered list of scan roots from defaults + extra paths. */
function buildRoots(extraPaths: string[] | undefined): Root[] {
  const defaults = defaultModelDirs();
  // defaultModelDirs() order is documented as huggingface, ollama, lmstudio.
  const sources: ModelSource[] = ["huggingface", "ollama", "lmstudio"];
  const roots: Root[] = [];
  for (let i = 0; i < defaults.length; i++) {
    const dir = defaults[i];
    if (dir === undefined) continue;
    roots.push({ dir: resolve(dir), source: sources[i] ?? "config" });
  }
  for (const p of extraPaths ?? []) {
    if (p.length === 0) continue;
    roots.push({ dir: resolve(p), source: "config" });
  }
  return roots;
}

/** Parse and uppercase a quant token from a filename, or null. */
export function parseQuant(filename: string): string | null {
  const m = QUANT_RE.exec(filename);
  return m && m[1] ? m[1].toUpperCase() : null;
}

/**
 * Best-effort author/org from the file path. Handles the Hugging Face hub cache
 * (`…/models--<org>--<name>/…`) and the `<root>/<org>/<name>/<file>` layout used
 * by llamactl downloads and LM Studio. Returns null when no org is apparent.
 */
export function parseOrg(path: string): string | null {
  const hub = /models--([^/]+?)--/.exec(path);
  if (hub && hub[1]) return hub[1];
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length >= 3) {
    const org = parts[parts.length - 3];
    const skip = new Set(["models", "model", "snapshots", "blobs", "hub", "gguf"]);
    if (org && !skip.has(org.toLowerCase())) return org;
  }
  return null;
}

/**
 * Best-effort Hugging Face repo id ("org/name") from the file path — what you'd
 * use to build a hf.co URL. The HF hub cache (`…/models--<org>--<name>/…`) is
 * exact; the `<root>/<org>/<name>/<file>` layout (LM Studio, etc.) is a
 * heuristic. GGUF metadata is NOT used: it's frequently absent or points at the
 * base model rather than the GGUF repo. Returns null when no repo is apparent.
 */
export function parseRepo(path: string): string | null {
  const hub = /models--([^/]+)/.exec(path);
  if (hub && hub[1]) {
    // huggingface_hub encodes "org/name" as "org--name"; the first "--" is the
    // original "/" (orgs never contain "--").
    const sep = hub[1].indexOf("--");
    if (sep > 0) return `${hub[1].slice(0, sep)}/${hub[1].slice(sep + 2)}`;
  }
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length >= 3) {
    const org = parts[parts.length - 3];
    const name = parts[parts.length - 2];
    const skip = new Set(["models", "model", "snapshots", "blobs", "hub", "gguf"]);
    if (org && name && !skip.has(org.toLowerCase())) return `${org}/${name}`;
  }
  return null;
}

/** Strip the `.gguf` extension (case-insensitive). */
function stripGguf(filename: string): string {
  return filename.replace(/\.gguf$/i, "");
}

/** Strip a trailing shard suffix, returning the base stem (no shard). */
function stripShard(stem: string): string {
  return stem.replace(SHARD_RE, "");
}

/**
 * Build a friendly display name: filename without extension, quant token and
 * shard suffix removed, separators tidied to spaces but still readable.
 */
function friendlyName(stem: string): string {
  let name = stripShard(stem);
  // Remove the quant token (with any adjacent separator) from the name.
  const q = QUANT_RE.exec(name);
  if (q && q[0]) {
    name = name.replace(QUANT_RE, " ");
  }
  // Collapse runs of -, _ and whitespace into a space, but KEEP dots so version
  // numbers like "3.1" / "Qwen3.5" / "0.6B" stay intact and readable.
  name = name.replace(/[-_\s]+/g, " ");
  // Collapse spaces and drop a stray separator dot left dangling at either end.
  name = name.replace(/\s+/g, " ").replace(/^[.\s]+|[.\s]+$/g, "").trim();
  return name.length > 0 ? name : stem;
}

/** Canonical slug from a filename stem: lowercase, sanitized, collapsed dashes. */
function slugify(stem: string): string {
  const base = stripShard(stem).toLowerCase();
  let id = base.replace(/[^a-z0-9._-]+/g, "-");
  id = id.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return id.length > 0 ? id : "model";
}

/** Short stable hash (first 6 hex) of an absolute path, for id disambiguation. */
function shortHash(absPath: string): string {
  return createHash("sha1").update(absPath).digest("hex").slice(0, 6);
}

/** Parsed shard info, if the stem is part of a multi-file model. */
interface ShardInfo {
  index: number;
  total: number;
}

function parseShard(stem: string): ShardInfo | null {
  const m = SHARD_RE.exec(stem);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const index = Number.parseInt(m[1], 10);
  const total = Number.parseInt(m[2], 10);
  if (!Number.isFinite(index) || !Number.isFinite(total)) return null;
  return { index, total };
}

/** Internal walk result: one discovered gguf file with stat data + source. */
interface Found {
  path: string;
  source: ModelSource;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * Recursively collect `*.gguf` files under `dir`. Tolerates unreadable dirs,
 * caps depth, and skips symlinked directories to avoid loops. Pushes results
 * into `out`.
 */
async function walk(
  dir: string,
  source: ModelSource,
  depth: number,
  out: Found[],
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing or unreadable — skip silently
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // Only follow symlinks that point at regular files; skip dir-symlinks
      // (loop risk) but still allow a symlinked .gguf file to be discovered.
      if (!/\.gguf$/i.test(entry.name)) continue;
      try {
        const st = await stat(full); // follows the link
        if (st.isFile()) {
          out.push({ path: full, source, sizeBytes: st.size, mtimeMs: st.mtimeMs });
        }
      } catch {
        // dangling / unreadable symlink — skip
      }
      continue;
    }
    if (entry.isDirectory()) {
      await walk(full, source, depth + 1, out);
      continue;
    }
    if (entry.isFile() && /\.gguf$/i.test(entry.name)) {
      try {
        const st = await stat(full);
        out.push({ path: full, source, sizeBytes: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // racing deletion / unreadable — skip
      }
    }
  }
}

/**
 * Recursively walk every default model dir plus `opts.extraPaths`, returning a
 * deduplicated list of `Model`s. Sharded ggufs collapse to a single entry
 * (represented by their first shard). Missing/unreadable dirs are skipped.
 */
export async function discoverModels(opts?: DiscoverOptions): Promise<Model[]> {
  const roots = buildRoots(opts?.extraPaths);
  const found: Found[] = [];
  // Avoid scanning the same absolute path twice if roots overlap.
  const seenDirs = new Set<string>();
  for (const root of roots) {
    if (seenDirs.has(root.dir)) continue;
    seenDirs.add(root.dir);
    await walk(root.dir, root.source, 0, found);
  }

  // Deduplicate the same absolute file path (overlapping roots).
  const byPath = new Map<string, Found>();
  for (const f of found) {
    if (!byPath.has(f.path)) byPath.set(f.path, f);
  }

  // Collapse shards: group by (containing dir + base stem) and keep the lowest
  // shard index as the representative. Non-sharded files have no group.
  const representatives: Found[] = [];
  const shardGroups = new Map<string, { rep: Found; repIndex: number }>();
  for (const f of byPath.values()) {
    const stem = stripGguf(basename(f.path));
    const shard = parseShard(stem);
    if (shard === null) {
      representatives.push(f);
      continue;
    }
    const dir = f.path.slice(0, f.path.length - basename(f.path).length);
    const key = `${dir} ${stripShard(stem)}`;
    const existing = shardGroups.get(key);
    if (existing === undefined || shard.index < existing.repIndex) {
      shardGroups.set(key, { rep: f, repIndex: shard.index });
    }
  }
  for (const g of shardGroups.values()) representatives.push(g.rep);

  // Build Models, disambiguating id collisions with a short path hash.
  const usedIds = new Set<string>();
  const models: Model[] = [];
  // Stable ordering so id-collision disambiguation is deterministic.
  representatives.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Read GGUF metadata (arch / context length / kind) for all reps in parallel.
  const metas = await Promise.all(representatives.map((f) => readGgufMeta(f.path)));
  for (let idx = 0; idx < representatives.length; idx++) {
    const f = representatives[idx]!;
    const meta = metas[idx]!;
    const stem = stripGguf(basename(f.path));
    const baseId = slugify(stem);
    let id = baseId;
    if (usedIds.has(id)) {
      id = `${baseId}-${shortHash(f.path)}`;
      // Extremely unlikely further collision: fall back to a longer hash.
      while (usedIds.has(id)) {
        id = `${baseId}-${createHash("sha1").update(f.path + id).digest("hex").slice(0, 10)}`;
      }
    }
    usedIds.add(id);
    models.push({
      id,
      name: friendlyName(stem),
      path: f.path,
      sizeBytes: f.sizeBytes,
      quant: parseQuant(stem),
      source: f.source,
      mtimeMs: f.mtimeMs,
      arch: meta.arch,
      contextLength: meta.contextLength,
      nLayers: meta.nLayers,
      kvDim: meta.kvDim,
      kind: meta.kind,
      org: parseOrg(f.path),
    });
  }
  return models;
}

/**
 * A multimodal projector ("mmproj") file — detected as `kind: "vision"` by GGUF
 * parsing (clip.* keys / arch "clip" / mmproj filename). It is the vision
 * companion to a real model, passed via `--mmproj`, and isn't independently
 * runnable, so the catalog hides it. The runnable multimodal model itself is a
 * normal text-arch GGUF (`kind: "text"`) and stays visible.
 */
export function isProjector(model: Model): boolean {
  return model.kind === "vision";
}

/** Catalog view: discovered models minus non-runnable projector files. */
export function runnableModels(models: Model[]): Model[] {
  return models.filter((m) => !isProjector(m));
}

/**
 * Resolve a user selector against a known model list. Match priority:
 *   1. exact id
 *   2. exact absolute path
 *   3. exact name (case-insensitive)
 *   4. substring on id or name (case-insensitive): unique → return; else throw.
 * Throws LlamactlError("model_not_found" | "ambiguous_model") on failure.
 */
export function resolveModel(models: Model[], selector: string): Model {
  const sel = selector.trim();

  // 1. exact id
  for (const m of models) {
    if (m.id === sel) return m;
  }
  // 2. exact absolute path
  for (const m of models) {
    if (m.path === sel) return m;
  }
  // 3. exact name (case-insensitive)
  const selLower = sel.toLowerCase();
  for (const m of models) {
    if (m.name.toLowerCase() === selLower) return m;
  }
  // 4. substring on id or name (case-insensitive)
  const matches = models.filter(
    (m) => m.id.toLowerCase().includes(selLower) || m.name.toLowerCase().includes(selLower),
  );
  if (matches.length === 1) {
    const only = matches[0];
    if (only !== undefined) return only;
  }
  if (matches.length > 1) {
    const ids = matches.map((m) => m.id).join(", ");
    throw new LlamactlError(
      "ambiguous_model",
      `Selector "${selector}" matches multiple models: ${ids}. Be more specific.`,
      { detail: { selector, candidates: matches.map((m) => m.id) } },
    );
  }
  throw new LlamactlError(
    "model_not_found",
    `No model matches selector "${selector}".`,
    { detail: { selector } },
  );
}

/**
 * Delete a model's file(s) from disk. Removes every shard of a sharded model,
 * and for files in the Hugging Face cache (a snapshot symlink into `blobs/`)
 * removes both the symlink and the underlying blob. Best-effort: missing files
 * are skipped. Returns the paths actually removed.
 */
export async function deleteModelFiles(model: Model): Promise<string[]> {
  const removed: string[] = [];
  const dir = dirname(model.path);
  const stem = stripGguf(basename(model.path));

  // Gather the files to remove: the whole shard group, or just this one file.
  let files: string[] = [model.path];
  if (SHARD_RE.test(stem)) {
    const prefix = stem.replace(SHARD_RE, "");
    const entries = await readdir(dir).catch(() => [] as string[]);
    const sibs = entries
      .filter((e) => {
        const s = stripGguf(e);
        return SHARD_RE.test(s) && s.replace(SHARD_RE, "") === prefix;
      })
      .map((e) => join(dir, e));
    if (sibs.length > 0) files = sibs;
  }

  for (const p of files) {
    try {
      const st = await lstat(p);
      if (st.isSymbolicLink()) {
        const target = await realpath(p).catch(() => null);
        await unlink(p).catch(() => {});
        removed.push(p);
        if (target) {
          await unlink(target).catch(() => {});
          removed.push(target);
        }
      } else {
        await unlink(p);
        removed.push(p);
      }
    } catch {
      // Already gone or unreadable — skip it.
    }
  }
  return removed;
}

/** Wrap a model list in the frozen `ModelResolver` interface. */
export function createResolver(models: Model[]): ModelResolver {
  return {
    resolve: (selector: string) => resolveModel(models, selector),
    all: () => models,
  };
}

/**
 * Watch the existing scan roots for changes and re-run discovery (debounced),
 * invoking `onChange` with the fresh list. Returns a stop function that closes
 * all watchers and clears any pending timer. Tolerant of watch errors and safe
 * inside a `bun build --compile` target (uses only node:fs `watch`).
 */
export function watchModels(
  opts: DiscoverOptions,
  onChange: (models: Model[]) => void,
): () => void {
  const roots = buildRoots(opts.extraPaths);
  const watchers: Array<{ close(): void }> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const trigger = (): void => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      void discoverModels(opts)
        .then((models) => {
          if (!stopped) onChange(models);
        })
        .catch(() => {
          // discovery failed transiently — ignore, next event will retry
        });
    }, 300);
  };

  const seen = new Set<string>();
  for (const root of roots) {
    if (seen.has(root.dir)) continue;
    seen.add(root.dir);
    const dir = root.dir;
    const startWatch = (recursive: boolean): void => {
      let w;
      try {
        w = watch(dir, { recursive, persistent: false }, () => trigger());
      } catch {
        // Recursive may be unsupported on this platform — fall back once.
        if (recursive) {
          startWatch(false);
        }
        return;
      }
      w.on("error", () => {
        try {
          w.close();
        } catch {
          /* ignore */
        }
      });
      watchers.push(w);
    };
    startWatch(true);
  }

  return () => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    watchers.length = 0;
  };
}
