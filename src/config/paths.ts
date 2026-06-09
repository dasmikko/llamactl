/**
 * Resolve per-user directories for state, cache, and config. Honors XDG on
 * Unix; uses sane platform equivalents on macOS and Windows. All bunstash
 * files live under a `bunstash/` subdir of these.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const APP = "bunstash";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

/** Base dir for durable runtime state (runtime.json lives here). */
export function stateDir(): string {
  if (process.platform === "win32") {
    return join(env("LOCALAPPDATA") ?? join(homedir(), "AppData", "Local"), APP, "state");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP);
  }
  return join(env("XDG_STATE_HOME") ?? join(homedir(), ".local", "state"), APP);
}

/** Base dir for caches and per-launch logs. */
export function cacheDir(): string {
  if (process.platform === "win32") {
    return join(env("LOCALAPPDATA") ?? join(homedir(), "AppData", "Local"), APP, "cache");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", APP);
  }
  return join(env("XDG_CACHE_HOME") ?? join(homedir(), ".cache"), APP);
}

/** Base dir for user configuration. */
export function configDir(): string {
  if (process.platform === "win32") {
    return join(env("APPDATA") ?? join(homedir(), "AppData", "Roaming"), APP);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP);
  }
  return join(env("XDG_CONFIG_HOME") ?? join(homedir(), ".config"), APP);
}

/** Absolute path to runtime.json. */
export function runtimePath(): string {
  return join(stateDir(), "runtime.json");
}

/** Absolute path to the user config file. */
export function configPath(): string {
  return join(configDir(), "config.json");
}

/** Directory holding per-launch logs. */
export function logsDir(): string {
  return join(cacheDir(), "logs");
}

/** Default model-cache directories scanned during discovery (Phase 2). */
export function defaultModelDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".cache", "huggingface"),
    join(home, ".ollama", "models"),
    join(home, ".lmstudio", "models"),
  ];
}
