/**
 * Configuration loading and merging. Precedence (lowest to highest):
 *   built-in defaults  →  config file (JSON)  →  env (BUNSTASH_*)  →  CLI flags
 *
 * Merging is intentionally pure and side-effect free so it is easy to test.
 */

import type { Config } from "../types.ts";
import { configPath } from "./paths.ts";

/** Ports used by the proxy in each mode. */
export const PROXY_PORT_DEFAULT = 11435;
export const PROXY_PORT_OLLAMA = 11434;
export const CONTROL_PORT_DEFAULT = 48134;

/** Built-in defaults. */
export function defaultConfig(): Config {
  return {
    modelPaths: [],
    controlPort: CONTROL_PORT_DEFAULT,
    proxy: { host: "127.0.0.1", port: PROXY_PORT_DEFAULT },
    llamaServerPath: null,
    defaultCtx: 4096,
    ollamaCompat: false,
    fallbackEnabled: false,
    llamaServerArgs: [],
  };
}

/** A partial, possibly-untrusted config object (from file/env/flags). */
export type PartialConfig = {
  modelPaths?: string[];
  controlPort?: number;
  proxy?: { host?: string; port?: number };
  llamaServerPath?: string | null;
  defaultCtx?: number;
  ollamaCompat?: boolean;
  fallbackEnabled?: boolean;
  llamaServerArgs?: string[];
};

/** Deep-merge a single override layer onto a base config. */
export function mergeConfig(base: Config, over: PartialConfig): Config {
  return {
    modelPaths: over.modelPaths ?? base.modelPaths,
    controlPort: over.controlPort ?? base.controlPort,
    proxy: {
      host: over.proxy?.host ?? base.proxy.host,
      port: over.proxy?.port ?? base.proxy.port,
    },
    llamaServerPath:
      over.llamaServerPath !== undefined ? over.llamaServerPath : base.llamaServerPath,
    defaultCtx: over.defaultCtx ?? base.defaultCtx,
    ollamaCompat: over.ollamaCompat ?? base.ollamaCompat,
    fallbackEnabled: over.fallbackEnabled ?? base.fallbackEnabled,
    llamaServerArgs: over.llamaServerArgs ?? base.llamaServerArgs,
  };
}

/** Parse a boolean-ish env string ("1", "true", "yes" → true). */
function envBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return undefined;
}

function envInt(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Build a PartialConfig from BUNSTASH_* environment variables. */
export function configFromEnv(env: Record<string, string | undefined>): PartialConfig {
  const out: PartialConfig = {};
  const paths = env.BUNSTASH_MODEL_PATHS;
  if (paths) out.modelPaths = paths.split(":").filter((p) => p.length > 0);
  const controlPort = envInt(env.BUNSTASH_CONTROL_PORT);
  if (controlPort !== undefined) out.controlPort = controlPort;
  const proxyHost = env.BUNSTASH_PROXY_HOST;
  const proxyPort = envInt(env.BUNSTASH_PROXY_PORT);
  if (proxyHost !== undefined || proxyPort !== undefined) {
    out.proxy = {};
    if (proxyHost !== undefined) out.proxy.host = proxyHost;
    if (proxyPort !== undefined) out.proxy.port = proxyPort;
  }
  const lsPath = env.BUNSTASH_LLAMA_SERVER;
  if (lsPath !== undefined) out.llamaServerPath = lsPath;
  const ctx = envInt(env.BUNSTASH_CTX);
  if (ctx !== undefined) out.defaultCtx = ctx;
  const ollama = envBool(env.BUNSTASH_OLLAMA_COMPAT);
  if (ollama !== undefined) out.ollamaCompat = ollama;
  const fallback = envBool(env.BUNSTASH_FALLBACK);
  if (fallback !== undefined) out.fallbackEnabled = fallback;
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

  // Ollama-compat implies the well-known port unless the user set one explicitly.
  if (cfg.ollamaCompat && opts.flags?.proxy?.port === undefined &&
      env.proxy?.port === undefined && file.proxy?.port === undefined) {
    cfg.proxy.port = PROXY_PORT_OLLAMA;
  }
  return cfg;
}
