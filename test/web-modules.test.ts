/**
 * Integrity of the front end's module graph.
 *
 * The browser code is buildless: native ES modules resolved by the browser
 * against the server's asset manifest, with no bundler to catch a typo'd path
 * or a renamed export. These tests do that check statically — every import
 * resolves to something the server actually serves, and every named binding is
 * really exported by its target — so a broken page fails here rather than as a
 * blank screen and a console error.
 */

import { describe, expect, test } from "bun:test";
import { ASSETS } from "../src/web/assets.ts";
import { SHARED_MODULES } from "../src/web/modules.ts";

/** Served URL → source, for every JavaScript module the page can load. */
function moduleGraph(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, asset] of ASSETS) {
    if (path.endsWith(".js")) out.set(path, asset.body);
  }
  for (const [path, src] of SHARED_MODULES) out.set(path, src);
  return out;
}

/** Resolve an import specifier against the importing module's URL. */
function resolve(fromUrl: string, specifier: string): string {
  if (specifier.startsWith("/")) return specifier;
  const stack = fromUrl.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

/** `import { a, b as c } from "x"` / `import x from "y"` across a module. */
const IMPORT_RE = /import\s+([^"';]+?)\s+from\s+["']([^"']+)["']/g;

interface ImportSite {
  specifier: string;
  /** Named bindings, by their exported name (before any `as`). */
  named: string[];
  /** True when the statement uses a default import. */
  hasDefault: boolean;
}

function importsOf(src: string): ImportSite[] {
  const out: ImportSite[] = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const clause = m[1]!;
    const braces = /\{([^}]*)\}/.exec(clause);
    const named = braces
      ? braces[1]!
          .split(",")
          .map((s) => s.trim().split(/\s+as\s+/)[0]!.trim())
          .filter((s) => s.length > 0)
      : [];
    // A default import is anything named before the braces, e.g. `x, { y }`.
    const hasDefault = /^[A-Za-z_$][\w$]*\s*(,|$)/.test(clause.trim());
    out.push({ specifier: m[2]!, named, hasDefault });
  }
  return out;
}

const transpiler = new Bun.Transpiler({ loader: "js" });

describe("front-end module graph", () => {
  const graph = moduleGraph();

  test("every module is reachable from the entry point", () => {
    const seen = new Set<string>();
    const queue = ["/app.js"];
    while (queue.length > 0) {
      const url = queue.pop()!;
      if (seen.has(url)) continue;
      seen.add(url);
      const src = graph.get(url);
      if (src === undefined) continue;
      for (const imp of importsOf(src)) queue.push(resolve(url, imp.specifier));
    }
    const orphans = [...graph.keys()].filter((url) => !seen.has(url));
    expect(orphans).toEqual([]);
  });

  test("every import resolves to a served module", () => {
    const broken: string[] = [];
    for (const [url, src] of graph) {
      for (const imp of importsOf(src)) {
        const target = resolve(url, imp.specifier);
        if (!graph.has(target)) broken.push(`${url} → ${imp.specifier} (${target})`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("every named import is actually exported by its target", () => {
    const missing: string[] = [];
    const exportsOf = new Map<string, string[]>();
    for (const [url, src] of graph) exportsOf.set(url, transpiler.scan(src).exports);

    for (const [url, src] of graph) {
      for (const imp of importsOf(src)) {
        const target = resolve(url, imp.specifier);
        const exported = exportsOf.get(target);
        if (!exported) continue; // unresolved paths are the previous test's job
        for (const name of imp.named) {
          if (!exported.includes(name)) missing.push(`${url} imports ${name} from ${target}`);
        }
        if (imp.hasDefault && !exported.includes("default")) {
          missing.push(`${url} imports a default from ${target}, which has none`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("the page's script tag and stylesheet are in the manifest", () => {
    const html = ASSETS.get("/index.html")!.body;
    for (const m of html.matchAll(/(?:src|href)="(\/[^"]+)"/g)) {
      expect(`${m[1]} served: ${ASSETS.has(m[1]!)}`).toBe(`${m[1]} served: true`);
    }
  });

  test("browser modules never import Bun or Node built-ins", () => {
    const offenders: string[] = [];
    for (const [url, src] of graph) {
      for (const imp of importsOf(src)) {
        if (/^(node:|bun:)/.test(imp.specifier)) offenders.push(`${url} → ${imp.specifier}`);
      }
      // The shared TUI modules are the risk here: they are project source, so a
      // future runtime dependency on Bun globals would break only in a browser.
      if (/\bBun\./.test(src)) offenders.push(`${url} uses the Bun global`);
    }
    expect(offenders).toEqual([]);
  });
});
