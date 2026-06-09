/**
 * Tiny zero-dependency argv parser. Supports:
 *   --flag            -> boolean true
 *   --no-flag         -> boolean false
 *   --key value       -> string
 *   --key=value       -> string
 *   -x                -> short boolean
 * Everything else is a positional. `--` stops option parsing; the rest are
 * positionals verbatim.
 */

export interface ParsedArgs {
  /** Positional arguments in order (command + operands). */
  positionals: string[];
  /** Parsed options. Values are string | boolean. */
  options: Record<string, string | boolean>;
}

/** Options that always take a value (so `--ctx 8192` doesn't eat a positional). */
const VALUE_OPTS = new Set([
  "ctx",
  "host",
  "port",
  "control-port",
  "llama-server",
  "config",
  "model-paths",
  "ngl",
  "gpu-layers",
  "n-cpu-moe",
  "ncmoe",
  "threads",
  "batch-size",
  "cache-type-k",
  "cache-type-v",
  "chat-template",
  "instance",
  "name",
  "extra-args",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  let i = 0;
  let optsDone = false;

  while (i < argv.length) {
    const arg = argv[i]!;
    if (optsDone) {
      positionals.push(arg);
      i++;
      continue;
    }
    if (arg === "--") {
      optsDone = true;
      i++;
      continue;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        options[body.slice(0, eq)] = body.slice(eq + 1);
        i++;
        continue;
      }
      if (body.startsWith("no-")) {
        options[body.slice(3)] = false;
        i++;
        continue;
      }
      const next = argv[i + 1];
      if (VALUE_OPTS.has(body) && next !== undefined) {
        options[body] = next;
        i += 2;
        continue;
      }
      // Bare long flag with a following non-option value is treated as boolean
      // unless it's a known value-opt (handled above). Keeps `list --json` clean.
      options[body] = true;
      i++;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (const ch of arg.slice(1)) options[ch] = true;
      i++;
      continue;
    }
    positionals.push(arg);
    i++;
  }

  return { positionals, options };
}

/** Read a string option value, or undefined. */
export function strOpt(a: ParsedArgs, key: string): string | undefined {
  const v = a.options[key];
  return typeof v === "string" ? v : undefined;
}

/** Read a boolean option (presence-or-true), defaulting to false. */
export function boolOpt(a: ParsedArgs, key: string): boolean {
  return a.options[key] === true;
}

/** Read a numeric option value, or undefined. */
export function numOpt(a: ParsedArgs, key: string): number | undefined {
  const v = a.options[key];
  if (typeof v !== "string") return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}
