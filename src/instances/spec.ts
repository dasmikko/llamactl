/**
 * Pure logic for `LaunchSpec`: applying config defaults, validation, and
 * mapping a spec to a `llama-server` argv. No filesystem or process access —
 * the supervisor depends on this, the instance store does not, so it stays
 * trivially unit-testable.
 */

import type { Config, LaunchSpec } from "../types.ts";
import { LlamactlError } from "../errors.ts";

/** Default loopback host; non-loopback binding is an explicit opt-in. */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * Canonical long flags already represented by structured `LaunchSpec` fields.
 * The TUI's generic "all flags" list hides these (they have richer dedicated
 * editors), and `specToArgs` skips them in `extraFlags` so a stray entry can't
 * duplicate a curated flag. `--help`/`--version`/`--usage` are listed too: they
 * are meaningless as launch flags.
 */
export const CURATED_FLAGS: ReadonlySet<string> = new Set([
  "--model",
  "--ctx-size",
  "--gpu-layers",
  "--n-cpu-moe",
  "--threads",
  "--batch-size",
  "--ubatch-size",
  "--parallel",
  "--alias",
  "--mmproj",
  "--mlock",
  "--mmap",
  "--no-mmap",
  "--flash-attn",
  "--reasoning",
  "--jinja",
  "--no-jinja",
  "--chat-template",
  "--cache-type-k",
  "--cache-type-v",
  "--host",
  "--port",
  "--help",
  "--usage",
  "--version",
]);

/** Allowed `--cache-type-k`/`--cache-type-v` values (llama.cpp). Default is f16. */
export const CACHE_TYPES = [
  "f32",
  "f16",
  "bf16",
  "q8_0",
  "q4_0",
  "q4_1",
  "iq4_nl",
  "q5_0",
  "q5_1",
] as const;

/**
 * Fill absent structured fields from config defaults. Returns a new spec;
 * does not mutate the input. `ctxSize`, `gpuLayers`, and `host` have defaults
 * (the GPU-layers default offloads to the GPU out of the box); everything else
 * stays absent and is simply not emitted as a flag. An explicit `gpuLayers: 0`
 * is preserved (CPU-only), since 0 is not nullish.
 */
export function applyDefaults(spec: LaunchSpec, config: Config): LaunchSpec {
  return {
    ...spec,
    ctxSize: spec.ctxSize ?? config.defaultCtx,
    gpuLayers: spec.gpuLayers ?? config.defaultGpuLayers,
    host: spec.host ?? DEFAULT_HOST,
  };
}

/** Throw LlamactlError("invalid_spec") if any field holds an illegal value. */
export function validateSpec(spec: LaunchSpec): void {
  if (!spec.model || spec.model.trim().length === 0) {
    throw new LlamactlError("invalid_spec", "launch spec is missing a model selector");
  }
  const posInt = (v: number | undefined, name: string): void => {
    if (v === undefined) return;
    if (!Number.isInteger(v) || v < 0) {
      throw new LlamactlError("invalid_spec", `${name} must be a non-negative integer (got ${v})`, {
        detail: { field: name, value: v },
      });
    }
  };
  posInt(spec.ctxSize, "ctxSize");
  posInt(spec.gpuLayers, "gpuLayers");
  posInt(spec.nCpuMoe, "nCpuMoe");
  posInt(spec.threads, "threads");
  posInt(spec.batchSize, "batchSize");
  posInt(spec.ubatchSize, "ubatchSize");
  posInt(spec.parallel, "parallel");
  if (spec.port !== undefined) {
    if (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535) {
      throw new LlamactlError("invalid_spec", `port must be in 1..65535 (got ${spec.port})`, {
        detail: { field: "port", value: spec.port },
      });
    }
  }
  if (spec.extraArgs && !spec.extraArgs.every((a) => typeof a === "string")) {
    throw new LlamactlError("invalid_spec", "extraArgs must be an array of strings");
  }
  if (spec.extraFlags) {
    for (const [flag, value] of Object.entries(spec.extraFlags)) {
      if (!flag.startsWith("-")) {
        throw new LlamactlError("invalid_spec", `extraFlags key must be a flag like "--foo" (got "${flag}")`, {
          detail: { field: "extraFlags", value: flag },
        });
      }
      if (value !== true && typeof value !== "string") {
        throw new LlamactlError("invalid_spec", `extraFlags["${flag}"] must be a string or true`, {
          detail: { field: "extraFlags", value: flag },
        });
      }
    }
  }
  const checkCacheType = (v: string | undefined, name: string): void => {
    if (v === undefined) return;
    if (!(CACHE_TYPES as readonly string[]).includes(v)) {
      throw new LlamactlError("invalid_spec", `${name} must be one of: ${CACHE_TYPES.join(", ")} (got ${v})`, {
        detail: { field: name, value: v },
      });
    }
  };
  checkCacheType(spec.cacheTypeK, "cacheTypeK");
  checkCacheType(spec.cacheTypeV, "cacheTypeV");
  const checkOnOff = (v: string | undefined, name: string): void => {
    if (v !== undefined && v !== "on" && v !== "off") {
      throw new LlamactlError("invalid_spec", `${name} must be "on" or "off" (got ${v})`, {
        detail: { field: name, value: v },
      });
    }
  };
  checkOnOff(spec.flashAttn, "flashAttn");
  checkOnOff(spec.reasoning, "reasoning");
  checkOnOff(spec.jinja, "jinja");
  checkOnOff(spec.mlock, "mlock");
  checkOnOff(spec.mmap, "mmap");
}

/**
 * Build the `llama-server` argv (excluding any spawn prefix and the binary
 * itself) for a resolved spec. Structured flags are emitted first, in a stable
 * order, only when their field is defined; then `spec.extraArgs` verbatim; then
 * the global `configArgs`. The caller supplies the resolved model path and the
 * assigned port (the spec's own `port` is honoured by the supervisor before it
 * calls this).
 */
export function specToArgs(opts: {
  modelPath: string;
  port: number;
  spec: LaunchSpec;
  configArgs: string[];
}): string[] {
  const { modelPath, port, spec, configArgs } = opts;
  const args: string[] = ["-m", modelPath, "--host", spec.host ?? DEFAULT_HOST, "--port", String(port)];

  if (spec.ctxSize !== undefined) args.push("--ctx-size", String(spec.ctxSize));
  if (spec.gpuLayers !== undefined) args.push("--gpu-layers", String(spec.gpuLayers));
  if (spec.nCpuMoe !== undefined) args.push("--n-cpu-moe", String(spec.nCpuMoe));
  if (spec.threads !== undefined) args.push("--threads", String(spec.threads));
  if (spec.batchSize !== undefined) args.push("--batch-size", String(spec.batchSize));
  if (spec.ubatchSize !== undefined) args.push("--ubatch-size", String(spec.ubatchSize));
  if (spec.parallel !== undefined) args.push("--parallel", String(spec.parallel));
  if (spec.alias !== undefined && spec.alias !== "") args.push("--alias", spec.alias);
  if (spec.mmproj !== undefined && spec.mmproj !== "") args.push("--mmproj", spec.mmproj);
  // --mlock is an enable-only flag; --mmap is on by default, disabled via --no-mmap.
  if (spec.mlock === "on") args.push("--mlock");
  if (spec.mmap === "off") args.push("--no-mmap");
  // Recent llama.cpp takes a value: `--flash-attn on|off|auto`. Emit on/off when
  // explicitly chosen; absent ⇒ leave unset (llama.cpp default is auto).
  if (spec.flashAttn === "on" || spec.flashAttn === "off") {
    args.push("--flash-attn", spec.flashAttn);
  }
  if (spec.reasoning === "on" || spec.reasoning === "off") {
    args.push("--reasoning", spec.reasoning);
  }
  // Jinja is a boolean flag with a --no- variant; undefined leaves the default.
  if (spec.jinja === "on") args.push("--jinja");
  else if (spec.jinja === "off") args.push("--no-jinja");
  if (spec.chatTemplate !== undefined && spec.chatTemplate !== "") {
    args.push("--chat-template", spec.chatTemplate);
  }
  if (spec.cacheTypeK !== undefined) args.push("--cache-type-k", spec.cacheTypeK);
  if (spec.cacheTypeV !== undefined) args.push("--cache-type-v", spec.cacheTypeV);
  // Arbitrary flags from the editor's "all flags" list: a string is emitted as
  // `<flag> <value>`, `true` as a bare switch. Curated flags are skipped so a
  // stray entry can't duplicate one emitted above.
  if (spec.extraFlags) {
    for (const [flag, value] of Object.entries(spec.extraFlags)) {
      if (CURATED_FLAGS.has(flag)) continue;
      if (value === true) args.push(flag);
      else if (value !== "") args.push(flag, value);
    }
  }
  if (spec.extraArgs) args.push(...spec.extraArgs);
  args.push(...configArgs);

  return args;
}
