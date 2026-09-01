/**
 * Shared logic served to the browser.
 *
 * The web UI needs the same row-joining, launch-spec and memory-estimate rules
 * the TUI uses. Reimplementing them in the page's JavaScript would be two
 * copies of the trickiest logic in the repo, drifting apart silently — so
 * instead we hand the browser the actual modules: `Bun.Transpiler` strips the
 * types at startup and the transpiled source is served as ES modules under
 * `/mod/`. Sources are imported as text, so this works identically from a
 * checkout and from the compiled binary, and `tsc` still type-checks them as
 * ordinary project files.
 *
 * Only modules whose *runtime* imports stay inside this set can be listed here.
 * Type-only imports vanish in transpilation, which is why `rows.ts` (all its
 * imports are `import type`) needs nothing alongside it, and `spec.ts` needs
 * only `errors.ts`.
 */

// These import the source *text* of real project modules. `./shared/*.ts.txt`
// are symlinks to the actual files — the indirection exists because a bare
// `import x from "../tui/rows.ts" with { type: "text" }` works at runtime but
// NOT through `Bun.build`, which resolves a `.ts` specifier as a module and
// fails with "No matching export for import default". The `.txt` extension
// picks the text loader in both, and the symlink means there is still exactly
// one copy of each file — edit `src/tui/rows.ts` and the browser gets it.
import errorsSrc from "./shared/errors.ts.txt" with { type: "text" };
import specSrc from "./shared/spec.ts.txt" with { type: "text" };
import estimateSrc from "./shared/estimate.ts.txt" with { type: "text" };
import rowsSrc from "./shared/rows.ts.txt" with { type: "text" };

/** Source text keyed by path relative to `src/`. */
const SOURCES: Record<string, string> = {
  "errors.ts": errorsSrc,
  "instances/spec.ts": specSrc,
  "instances/estimate.ts": estimateSrc,
  "tui/rows.ts": rowsSrc,
};

/** URL a shared module is served at, e.g. "tui/rows.ts" → "/mod/tui/rows.js". */
export function moduleUrl(key: string): string {
  return `/mod/${key.replace(/\.ts$/, ".js")}`;
}

/**
 * Resolve a relative import specifier against the importing module's key,
 * yielding another key in `SOURCES` (or null for a bare/unknown specifier).
 */
function resolveKey(fromKey: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const stack = fromKey.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

/** `from "./x.ts"` / `import "./x.ts"` — the specifiers left after transpiling. */
const SPECIFIER_RE = /(\bfrom\s*|\bimport\s*)(["'])(\.[^"']*)\2/g;

/**
 * Transpile every shared module and rewrite its relative specifiers to the URLs
 * they are served at. A specifier that doesn't resolve into `SOURCES` is a bug
 * in this list (a module pulling in a runtime dependency we don't serve), so it
 * throws at startup rather than 404-ing in the browser later.
 */
function buildModules(): Map<string, string> {
  const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
  const out = new Map<string, string>();
  for (const [key, src] of Object.entries(SOURCES)) {
    const js = transpiler.transformSync(src).replace(
      SPECIFIER_RE,
      (_match, lead: string, quote: string, specifier: string) => {
        const target = resolveKey(key, specifier);
        if (target === null || !(target in SOURCES)) {
          throw new Error(
            `src/${key} imports "${specifier}" at runtime, which is not a served shared module`,
          );
        }
        return `${lead}${quote}${moduleUrl(target)}${quote}`;
      },
    );
    out.set(moduleUrl(key), js);
  }
  return out;
}

/** Served URL → transpiled ES module source. Built once at import time. */
export const SHARED_MODULES: ReadonlyMap<string, string> = buildModules();
