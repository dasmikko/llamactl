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

const outfile = process.argv[2] ?? "llamactl";
const entry = process.argv[3] ?? "src/index.ts";

const result = await Bun.build({
  entrypoints: [entry],
  target: "bun",
  plugins: [solidPlugin],
  compile: { outfile },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log(`Built ${outfile}`);
