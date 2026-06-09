/**
 * Hugging Face Hub HTTP client — no SDK, just the global `fetch` and a few pure
 * parsers. The network-touching functions (`searchModels`, `listGgufFiles`)
 * delegate all JSON shaping to the exported pure helpers (`parseSearch`,
 * `parseTree`) so the parsing logic is unit-testable without hitting the wire.
 * Failures surface as `LlamactlError("hf_error", ...)` with actionable hints.
 */

import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import type { HfFile, HfRepo } from "../types.ts";
import { LlamactlError } from "../errors.ts";
import { parseQuant } from "../discovery/models.ts";

/** Base URL for the Hugging Face Hub website + API. */
export const HF_BASE = "https://huggingface.co";

/**
 * Build the direct-download URL for a file inside a repo at a given revision.
 * Each path segment of `file` is URL-encoded individually so slashes survive
 * (a repo file may live in a subdirectory). `?download=true` asks the Hub for
 * the file bytes rather than an HTML page.
 */
export function fileUrl(repo: string, file: string, revision = "main"): string {
  const encoded = file
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${HF_BASE}/${repo}/resolve/${revision}/${encoded}?download=true`;
}

/**
 * Read the cached Hugging Face token from `~/.cache/huggingface/token` (or
 * `${HF_HOME}/token` when `HF_HOME` is set). Trims surrounding whitespace and
 * returns null if the file is absent or empty. Never throws.
 */
export async function readHfTokenFromCache(): Promise<string | null> {
  const hfHome = process.env["HF_HOME"];
  const tokenPath =
    hfHome && hfHome.length > 0
      ? join(hfHome, "token")
      : join(homedir(), ".cache", "huggingface", "token");
  try {
    const raw = await readFile(tokenPath, "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null; // missing / unreadable — treat as no token
  }
}

/** Build request headers, attaching a bearer token when one is provided. */
function authHeaders(token: string | null | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Search the Hub for GGUF model repos matching `query`, sorted by downloads.
 * Sends a bearer token when provided. Throws `LlamactlError("hf_error")` on a
 * non-OK HTTP response or a network failure.
 */
export async function searchModels(
  query: string,
  opts?: { token?: string | null; limit?: number },
): Promise<HfRepo[]> {
  const limit = opts?.limit ?? 25;
  const url =
    `${HF_BASE}/api/models?search=${encodeURIComponent(query)}` +
    `&filter=gguf&sort=downloads&direction=-1&limit=${limit}`;

  let res: Response;
  try {
    res = await fetch(url, { headers: authHeaders(opts?.token) });
  } catch (e) {
    throw new LlamactlError(
      "hf_error",
      `Hugging Face search failed: ${e instanceof Error ? e.message : String(e)}`,
      { detail: { query } },
    );
  }
  if (!res.ok) {
    throw new LlamactlError(
      "hf_error",
      `Hugging Face search returned HTTP ${res.status} ${res.statusText}.`,
      { detail: { query, status: res.status } },
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    throw new LlamactlError(
      "hf_error",
      `Hugging Face search returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      { detail: { query } },
    );
  }
  return parseSearch(json);
}

/**
 * List the `.gguf` files in `repo` at the given revision (default "main").
 * Uses the recursive tree API. Throws `LlamactlError("hf_error")` on failure;
 * a 401/403 hints that a token may be required for a gated/private repo.
 */
export async function listGgufFiles(
  repo: string,
  opts?: { token?: string | null; revision?: string },
): Promise<HfFile[]> {
  const revision = opts?.revision ?? "main";
  const url = `${HF_BASE}/api/models/${repo}/tree/${revision}?recursive=true`;

  let res: Response;
  try {
    res = await fetch(url, { headers: authHeaders(opts?.token) });
  } catch (e) {
    throw new LlamactlError(
      "hf_error",
      `Hugging Face file listing failed: ${e instanceof Error ? e.message : String(e)}`,
      { detail: { repo, revision } },
    );
  }
  if (!res.ok) {
    const authHint =
      res.status === 401 || res.status === 403
        ? " This repo may be gated/private — pass a Hugging Face token."
        : "";
    throw new LlamactlError(
      "hf_error",
      `Hugging Face file listing for "${repo}" returned HTTP ${res.status} ${res.statusText}.${authHint}`,
      { detail: { repo, revision, status: res.status } },
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    throw new LlamactlError(
      "hf_error",
      `Hugging Face file listing returned invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
      { detail: { repo, revision } },
    );
  }
  return parseTree(json);
}

/* -------------------------------------------------------------------------- */
/* Pure parsers — the unit-testable core. No network, no I/O.                  */
/* -------------------------------------------------------------------------- */

/** Read a string property from a record, or undefined. */
function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

/** Read a finite number property from a record, defaulting to 0. */
function getNumber(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Parse the `/api/models` search array into `HfRepo`s. Each item may name its
 * id as `id` or `modelId`, and its timestamp as `lastModified` or `updatedAt`.
 * `gated` may be `false | "auto" | "manual" | true` — any truthy non-false
 * value counts as gated. Items without a string id are skipped.
 */
export function parseSearch(json: unknown): HfRepo[] {
  if (!Array.isArray(json)) return [];
  const repos: HfRepo[] = [];
  for (const item of json) {
    if (item === null || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = getString(obj, "id") ?? getString(obj, "modelId");
    if (id === undefined) continue; // need a stable id
    const updatedAt = getString(obj, "lastModified") ?? getString(obj, "updatedAt") ?? null;
    // gated: false → not gated; "auto"/"manual"/true → gated.
    const gatedRaw = obj["gated"];
    const gated = gatedRaw !== undefined && gatedRaw !== false && gatedRaw !== null;
    repos.push({
      id,
      likes: getNumber(obj, "likes"),
      downloads: getNumber(obj, "downloads"),
      updatedAt,
      gated,
    });
  }
  return repos;
}

/**
 * Parse the recursive tree array into `HfFile`s, keeping only regular files
 * whose path ends with `.gguf` (case-insensitive). Size becomes `sizeBytes`
 * (null if not a number) and the quant is parsed from the basename. Sorted by
 * `rfilename` for stable output.
 */
export function parseTree(json: unknown): HfFile[] {
  if (!Array.isArray(json)) return [];
  const files: HfFile[] = [];
  for (const item of json) {
    if (item === null || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (obj["type"] !== "file") continue;
    const path = getString(obj, "path");
    if (path === undefined || !/\.gguf$/i.test(path)) continue;
    const size = obj["size"];
    const sizeBytes = typeof size === "number" && Number.isFinite(size) ? size : null;
    files.push({
      rfilename: path,
      sizeBytes,
      quant: parseQuant(basename(path)),
    });
  }
  files.sort((a, b) => (a.rfilename < b.rfilename ? -1 : a.rfilename > b.rfilename ? 1 : 0));
  return files;
}
