/**
 * Hugging Face Hub cache layout helpers. Downloads land in the same on-disk
 * structure that `huggingface_hub` (and llama.cpp's `-hf`) use, so a model
 * fetched by llamactl is shared with llama.cpp and never downloaded twice:
 *
 *   <root>/models--<org>--<name>/
 *     refs/<revision>            # text file holding the commit sha
 *     blobs/<etag>               # the file content (named by its hash)
 *     snapshots/<commit>/<file>  # relative symlink -> ../../blobs/<etag>
 */

import { homedir } from "node:os";
import { join } from "node:path";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

/** Hugging Face home dir (`HF_HOME`, else `~/.cache/huggingface`). */
export function hfHome(): string {
  return env("HF_HOME") ?? join(homedir(), ".cache", "huggingface");
}

/** The Hub cache root: `HF_HUB_CACHE`, else `<HF_HOME>/hub`. */
export function hfHubCacheDir(): string {
  return env("HF_HUB_CACHE") ?? join(hfHome(), "hub");
}

/** Cache directory for a repo: `<root>/models--<org>--<name>`. */
export function repoCacheDir(root: string, repo: string): string {
  return join(root, `models--${repo.replace(/\//g, "--")}`);
}

/** Normalize an ETag / X-Linked-Etag header into a bare blob hash, or null. */
export function cleanEtag(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.replace(/^W\//, "").replace(/^"+|"+$/g, "").trim();
  return v.length > 0 ? v : null;
}
