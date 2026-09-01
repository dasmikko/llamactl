/**
 * Compile llamactl to a standalone native binary.
 *
 * The TUI is Solid JSX (opentui), which needs the babel-preset-solid transform
 * that `bun build --compile` on the CLI does not apply — so we drive Bun.build()
 * directly with the opentui Solid plugin. The opentui native renderer
 * (`libopentui.so`, imported via `with { type: "file" }`) is embedded into the
 * binary by Bun's compiler and dlopen'd at runtime.
 */

import solidPlugin from "@opentui/solid/bun-plugin";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { BunPlugin } from "bun";

/**
 * Load `src/web/shared/*.ts.txt` as text.
 *
 * Those are symlinks to real project modules whose *source* the web server
 * serves to the browser (see src/web/modules.ts). The Bun runtime honours the
 * `.txt` text loader on them directly, but the bundler resolves a symlink to
 * its real path first — and since those same files are already in the module
 * graph as ordinary imports, it dedupes onto the module and the text import
 * fails with "No matching export for import default".
 *
 * The fix is to keep the *symlink* path (never realpath it) and load it in a
 * private namespace, so the text copy and the module copy stay distinct graph
 * entries. `readFile` follows the symlink, so there is still one file on disk.
 */
const sharedSourcePlugin: BunPlugin = {
  name: "llamactl-shared-source",
  setup(build) {
    build.onResolve({ filter: /\.ts\.txt$/ }, (args) => ({
      path: resolve(dirname(args.importer), args.path),
      namespace: "shared-source",
    }));
    build.onLoad({ filter: /.*/, namespace: "shared-source" }, async (args) => ({
      contents: await readFile(args.path, "utf8"),
      loader: "text",
    }));
  },
};

const outfile = process.argv[2] ?? "llamactl";
const entry = process.argv[3] ?? "src/index.ts";

const result = await Bun.build({
  entrypoints: [entry],
  target: "bun",
  plugins: [solidPlugin, sharedSourcePlugin],
  compile: { outfile },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`Built ${outfile}`);
