/**
 * Configuration loading and merging. Precedence (lowest to highest):
 *   built-in defaults  →  config file (JSON)  →  env (LLAMACTL_*)  →  CLI flags
 *
 * Merging is intentionally pure and side-effect free so it is easy to test.
 */

import type { Config } from "../types.ts";
import { configPath } from "./paths.ts";

export const CONTROL_PORT_DEFAULT = 48134;
/** Offload all layers to the GPU by default; override per-spec for CPU/partial. */
export const DEFAULT_GPU_LAYERS = 99;

/** Built-in defaults. */
export function defaultConfig(): Config {
  return {
    modelPaths: [],
    controlPort: CONTROL_PORT_DEFAULT,
    llamaServerPath: null,
    defaultCtx: 4096,
    defaultGpuLayers: DEFAULT_GPU_LAYERS,
    llamaServerArgs: [],
  };
}

/** A partial, possibly-untrusted config object (from file/env/flags). */
export type PartialConfig = {
  modelPaths?: string[];
  controlPort?: number;
  llamaServerPath?: string | null;
  defaultCtx?: number;
  defaultGpuLayers?: number;
  llamaServerArgs?: string[];
};

/** Deep-merge a single override layer onto a base config. */
export function mergeConfig(base: Config, over: PartialConfig): Config {
  return {
    modelPaths: over.modelPaths ?? base.modelPaths,
    controlPort: over.controlPort ?? base.controlPort,
    llamaServerPath:
      over.llamaServerPath !== undefined ? over.llamaServerPath : base.llamaServerPath,
    defaultCtx: over.defaultCtx ?? base.defaultCtx,
    defaultGpuLayers: over.defaultGpuLayers ?? base.defaultGpuLayers,
    llamaServerArgs: over.llamaServerArgs ?? base.llamaServerArgs,
  };
}

function envInt(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Build a PartialConfig from LLAMACTL_* environment variables. */
export function configFromEnv(env: Record<string, string | undefined>): PartialConfig {
  const out: PartialConfig = {};
  const paths = env.LLAMACTL_MODEL_PATHS;
  if (paths) out.modelPaths = paths.split(":").filter((p) => p.length > 0);
  const controlPort = envInt(env.LLAMACTL_CONTROL_PORT);
  if (controlPort !== undefined) out.controlPort = controlPort;
  const lsPath = env.LLAMACTL_LLAMA_SERVER;
  if (lsPath !== undefined) out.llamaServerPath = lsPath;
  const ctx = envInt(env.LLAMACTL_CTX);
  if (ctx !== undefined) out.defaultCtx = ctx;
  const ngl = envInt(env.LLAMACTL_GPU_LAYERS);
  if (ngl !== undefined) out.defaultGpuLayers = ngl;
  return out;
}

/**
 * Read and parse the JSON config file. Returns an empty partial if the file is
 * absent. Throws a clear error if it exists but is malformed.
 */
export async function loadConfigFile(path = configPath()): Promise<PartialConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  let text: string;
  try {
    text = await file.text();
  } catch (e) {
    throw new Error(`failed to read config file at ${path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text) as PartialConfig;
  } catch (e) {
    throw new Error(`config file at ${path} is not valid JSON: ${(e as Error).message}`);
  }
}

/**
 * Resolve effective config by merging all layers. `flags` is the highest-
 * precedence override (already parsed from argv by the caller).
 */
export async function resolveConfig(opts: {
  flags?: PartialConfig;
  env?: Record<string, string | undefined>;
  configFile?: string;
}): Promise<Config> {
  const file = await loadConfigFile(opts.configFile);
  const env = configFromEnv(opts.env ?? process.env);
  let cfg = defaultConfig();
  cfg = mergeConfig(cfg, file);
  cfg = mergeConfig(cfg, env);
  if (opts.flags) cfg = mergeConfig(cfg, opts.flags);
  return cfg;
}
