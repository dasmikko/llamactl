# CLAUDE.md

Guidance for working in this repo. Read this first.

## What this is

`llamactl` — a Bun + TypeScript + **SolidJS + opentui** terminal UI for managing
local `llama-server` (llama.cpp) instances. It discovers cached GGUF models, saves
per-model launch-flag profiles, runs instances via a background daemon, and shows
live CPU / RAM / GPU / VRAM (+ temperatures). There is also a full headless CLI.

## Commands

```sh
bun install
bun test                 # full suite (uses a fake llama-server; no real model needed)
bun test test/spec.test.ts   # a single file
bun run test:e2e         # web UI in a real browser (needs: bunx playwright install chromium)
bun run typecheck        # tsc --noEmit (strict; noUnusedLocals on; covers src + test)
bun run build            # scripts/build.ts → Bun.build + @opentui/solid plugin → native binary
bun run start            # run the TUI from source (= bun --preload @opentui/solid/preload src/index.ts)
```

Running from source needs the opentui Solid preload so the `.tsx` JSX is
transformed at import time (`bun run start`, or `bun --preload @opentui/solid/preload
src/index.ts`). **Do not run `bun src/index.ts` bare** — the TUI import fails
without it. `bun test` gets the preload via `bunfig.toml [test]`. The compiled
binary needs no preload (the build plugin transforms JSX ahead of time), which is
why the preload is scoped to test/dev, NOT a top-level bunfig preload (Bun would
otherwise bake it into `--compile` and the binary would fail at startup).

Always run **both** `bun run typecheck` and `bun test` before considering a change
done. `tsc` strictness (`noUnusedLocals`/`noUnusedParameters`) catches dead
imports the tests won't.

⚠️ The script must invoke `tsc` directly, NOT `bunx tsc` — `bunx tsc --noEmit`
exits 0 without checking a single file, so for a while typechecking was silently
a no-op and `test/` had accumulated real type errors. If `bun run typecheck`
ever passes suspiciously fast, check it still says `$ tsc --noEmit`.

## Architecture

`src/types.ts` is the **frozen contract** — every module imports its shapes from
here (`LaunchSpec`, `Model`, `RunningModel`, `InstanceConfig`, `StatsSnapshot`,
the control-plane wire types, and the `ISupervisor`/`InstanceStore`/`ModelResolver`
interfaces). Change a shape here and the compiler shows you every consumer.

Data flow:

```
TUI / CLI ──(loopback HTTP + bearer token)──► Control plane ──► Supervisor ──► llama-server child(ren)
                                                    ▲
                                       Resource sampler (/proc + sysfs + nvidia-smi)
```

| Area | Files |
| --- | --- |
| Contract | `src/types.ts` |
| Config (XDG paths, layered merge) | `src/config/paths.ts`, `src/config/config.ts` |
| Discovery (GGUF scan + metadata) | `src/discovery/models.ts`, `src/discovery/gguf.ts` |
| Launch specs (argv mapping, profiles) | `src/instances/spec.ts`, `src/instances/store.ts` |
| Supervisor (spawn/health/restart) | `src/supervisor/process.ts` |
| Hugging Face (search + downloads) | `src/hf/client.ts`, `src/hf/download.ts` |
| Daemon + control plane + client | `src/daemon/*` |
| Monitoring | `src/monitor/proc.ts`, `nvidia.ts`, `sampler.ts` |
| Headless CLI | `src/index.ts`, `src/cli/*` |
| Web UI | `src/web/server.ts`, `modules.ts`, `assets.ts`, `public/*` (buildless ES modules), `src/logs/tail.ts` |
| TUI (Solid + opentui) | `src/tui/*` (`app.tsx` is the root + `runTui` entry); build via `scripts/build.ts` |

## How key things work (so you don't relearn them)

- **The daemon is long-lived.** It runs the source at the time it started
  (`bun … daemon __run`). **Code changes do not take effect until the daemon
  restarts** (`llamactl daemon stop`, then any command respawns it). This has
  bitten us — if a flag/behavior change "isn't working," check for a stale daemon
  first (`pgrep -af "daemon __run"`).
- **`llama-server` flags** are built ONLY in `src/instances/spec.ts` →
  `specToArgs`. To add a flag: add the field to `LaunchSpec` (types.ts), emit it
  in `specToArgs`, validate in `validateSpec`, add it to the TUI `FlagEditor`
  (text field or `←/→` enum chooser) and the CLI `flagsToSpec` (`src/cli/commands.ts`)
  + `VALUE_OPTS` (`src/cli/args.ts`) + help (`src/index.ts`). Follow how
  `cacheTypeK`/`reasoning` thread through.
- **Defaults** live in `applyDefaults` (spec.ts) + `defaultConfig` (config.ts):
  ctx 4096, **gpu-layers 99 (offload all by default)**, host 127.0.0.1. An
  explicit `0` is preserved (CPU-only).
- **Readiness:** the supervisor proactively polls each child's `/health` in the
  background (`beginReadinessProbe`) and flips `starting → ready`. Nothing else
  drives that transition (the proxy that used to is gone).
- **Hugging Face:** the daemon owns a `DownloadManager` (`src/hf/download.ts`,
  background streaming downloads with progress/cancel/shard-expansion) and an HF
  API client (`src/hf/client.ts`). Control plane: `/hf/search`, `/hf/files`,
  `/pull`, `/downloads`, `/downloads/:id/cancel`. **Downloads use the standard HF
  Hub cache layout** (`src/hf/cache.ts`: `models--<org>--<name>/{blobs,snapshots,refs}`
  under `config.downloadDir` = `hfHubCacheDir()`), so they're shared with llama.cpp's
  `-hf` (`llama-server --cache-list` sees them) and blobs already cached aren't
  re-downloaded. The `run()` reads `X-Repo-Commit`/`X-Linked-Etag` from a
  `redirect:"manual"` metadata request, writes `blobs/<etag>`, symlinks
  `snapshots/<commit>/<file>` → blob, writes `refs/<rev>`; a flat fallback kicks in
  when those headers are absent (local-server tests). `onComplete` → the daemon
  re-discovers so the model appears; finished entries auto-clear after a grace
  period. Token resolves from `config.hfToken` else the HF CLI cache. TUI: `p`
  opens `HfBrowser`; progress shows in `Downloads.tsx`.
- **Stats:** the daemon samples on an interval and serves a cached `StatsSnapshot`
  at `GET /stats`; the TUI polls it (alongside `/downloads`). CPU% is delta-based (first tick reads 0).
  All cross-sample state lives in `src/monitor/sampler.ts`; `proc.ts`/`nvidia.ts`
  are stateless and expose pure parse helpers for tests.
- **TUI selection** is tracked by `modelId`, not row index, so the cursor follows
  a model when the list re-sorts. The list is sections (ACTIVE INSTANCES /
  ★ FAVORITES / MODELS catalog) computed in `src/tui/rows.ts`. The MODELS catalog
  is **grouped by HF repo** (a colored header per `repo`, variants indented).
- **Profiles are not rows.** Each discovered model is one row carrying all its
  saved profiles in `Row.profiles`. `Enter` opens the launch picker (Default / a
  saved profile / + New) and `e` opens the profile manager (switch / create /
  edit / delete) — both are `ProfileDialog` (`src/tui/ProfileDialog.tsx`). Only an
  *orphan* profile (its model isn't discovered) still gets its own standalone row.
- **Companion GGUFs are not runnable rows.** Some files in a repo are inputs to
  another model, not models themselves: a vision projector (`kind: "vision"`,
  passed via `--mmproj`) and an MTP/NextN head (`kind: "mtp"`, passed via
  `--spec-draft-model`). `runnableModels()` hides both from the catalog. MTP
  heads are detected by **naming convention only** (`MTP/mtp-*.gguf`) — do NOT
  use `{arch}.nextn_predict_layers` for this, even though it is the key
  llama.cpp gates MTP on: it declares the *architecture* has an MTP head, so the
  base quant reports it too. We tried, and it hid the real model from the
  catalog and made it its own draft model — a second full copy of the weights,
  then a CUDA OOM at load. `findMtpHead()` pairs a head to its base model (same
  repo + quant, then same repo, then proximity), refusing any candidate that is
  the model itself or not smaller than it; the supervisor uses it to auto-fill
  `specDraftModel` when a spec asks for `--spec-type draft-mtp` without naming a
  head. This matters because llama.cpp **fails soft** the other way: no head ⇒
  one warning, then it serves with speculation silently disabled.
- **Startup warnings are surfaced, not buried.** After `/health` first succeeds,
  the supervisor scrapes `W`/`E` lines out of the child's log
  (`parseLogWarnings`, a pure exported helper) onto `RunningModel.warnings`. The
  TUI marks the row (`ready!`, painted amber) and lists the lines in `ModelInfo`.
  Several llama-server misconfigurations only ever announce themselves this way
  — a missing MTP head, `--gpu-layers` on a build without GPU support.
- **Model display names** are the raw GGUF filename stem (shard suffix removed,
  quant + separators kept) — see `friendlyName` in `src/discovery/models.ts`.
- **TUI is SolidJS + opentui** (migrated from React + Ink). Conventions so you
  don't reintroduce React habits: component bodies run **once** — anything derived
  from reactive state must be an accessor (`() => ...`) or `createMemo`, never a
  captured `const`; never destructure `props`. `useState→createSignal`,
  `useEffect→createEffect`/`onMount`+`onCleanup`, `useMemo→createMemo`; lists use
  `<For>`, conditionals `<Show>`/`<Switch>`. Intrinsics are lowercase (`<box>`/
  `<text>`); Ink `<Box>` defaulted to row but opentui/Yoga default to **column**,
  so horizontal rows need explicit `flexDirection="row"`. ⛔ **Never nest `<text>`
  inside `<text>`** (opentui throws at runtime — this is what emptied the model
  list) and `<span>` doesn't type `fg`/`attributes`: render inline colored runs as
  **sibling `<text>` in a `<box flexDirection="row">`**. Colors are hardcoded
  (`fg="cyan"`, no theme); `bold`/`dimColor`/`inverse`→`attributes={TextAttributes.*}`
  (from `@opentui/core`); borders need `border borderStyle="rounded"`; a left-only
  border is `border={["left"]}`. Keyboard: `useInput((input,key))`→`useKeyboard((key))`
  from `@opentui/solid` (`key.name`/`key.ctrl`/`key.sequence`; lone Esc fires after
  a 20ms flush — `key.name === "escape"` works). Shared primitives:
  `src/tui/textinput.tsx` (`CursorText` block-cursor input + `editText(state, key, accept?)`)
  and `src/tui/ShortcutBar.tsx` — reuse them in forms/footers. `useDaemon` returns a
  `createStore` as `daemon.state` plus action methods. Headless render tests use
  opentui's `testRender`+`captureCharFrame` (`test/tui-render.test.tsx`).
- **The web UI (`llamactl web`) is a daemon *client*, not part of the daemon.**
  `src/web/server.ts` serves the page and proxies its `/api/*` calls to the
  control plane, injecting the bearer token server-side — the browser never
  sees it, and the control plane keeps its loopback-only invariant. It resolves
  the upstream through the same `connectDaemon()` the CLI uses and re-resolves
  once on a 401, because the daemon rotates its token on every restart. Two
  things it must keep doing: never relay the browser's `Authorization`/`Cookie`
  upstream, and reject a request whose `Origin` doesn't match its `Host` (that
  check, not CORS, is what stops a random web page from driving a loopback
  server). Four routes are served locally instead of proxied, because they need
  host access the daemon has no route for: `/api/logs/model/:id` and
  `/api/logs/build/:id` (paths come from the daemon's own `/ps` and `/installs`
  records, **never** from the client — a client-supplied path would be an
  arbitrary-file-read hole), `/api/chat/:id` (streams the child's
  OpenAI-compatible endpoint, which a browser can't reach), and
  `/api/daemon/restart` (a browser can't fork a process).
- **The web front end is buildless and shares the TUI's logic verbatim.**
  `src/web/public/*` are plain ES modules the browser loads directly (no
  bundler, no framework), listed in the `assets.ts` manifest and imported as
  text so they end up inside the compiled binary. `src/web/modules.ts`
  transpiles `rows.ts`, `spec.ts`, `estimate.ts` and `errors.ts` with
  `Bun.Transpiler` and serves them under `/mod/`, so row grouping, flag
  validation and the memory estimate are the *same code* as the TUI's, not a
  reimplementation. Only modules whose runtime imports stay inside that set can
  be added (type-only imports vanish, which is why `rows.ts` needs nothing
  alongside it) — `modules.ts` throws at startup otherwise.
- **Enum flags are detected from `--help`, not hardcoded.** `parseLlamaHelp`
  finds all three spellings of a choice list and puts them in
  `LlamaFlag.enumValues`: braced (`--rope-scaling {none,linear,yarn}`), bare
  comma-separated (`--spec-type none,draft-simple,…`), and named in the prose
  (`--spec-draft-type-k TYPE … allowed values: f32, f16, …`). It sets
  `multiple: true` when the help says "comma-separated list of …". A candidate
  is only read as an enum when every token is lowercase, so metavars like
  `--tensor-split N0,N1,N2` stay free text. On the current binary this finds 8
  enum flags out of 244. The web flag editor renders a `<select>` for a
  single-choice enum and a checkbox group for a multi-valued one, so a new enum
  flag in a future llama.cpp build gets a picker with no code change. The TUI's
  generic flag list does not use `enumValues` yet — the data is there if it
  should.
- **The web flag editor's `extra*` fields are raw flags, gated on the binary.**
  Its "Speculative decoding" and "Sampling defaults" sections edit flags that
  are NOT `LaunchSpec` fields (`--spec-type`, `--spec-draft-n-max`, `--temp`,
  `--top-k`, …); they live in `extraFlags`, which is exactly where
  `src/supervisor/process.ts` reads `--spec-type` to decide whether to auto-fill
  an MTP head. Because those are passed to `llama-server` verbatim, each field
  only renders when the active binary advertises that flag in `--help` (a whole
  section disappears if none of its flags exist), so an older build is never
  handed an argument it would reject. The binary's own default becomes the
  input's placeholder, trimmed at the first comma — llama.cpp writes the value
  and an aside in one parenthesis, `(default: 40, 0 = disabled)`. Context size
  gets a preset picker beside its free-text box (the TUI's `CTX_PRESETS`), with
  presets above the model's trained `contextLength` dropped and that maximum
  offered as the last option.
- **Three traps live in the web layer's plumbing.** (1) `with { type: "text" }`
  on a `.ts` path works at runtime but **not** through `Bun.build`, which
  resolves it as a module — hence the `src/web/shared/*.ts.txt` symlinks plus
  the `shared-source` plugin in `scripts/build.ts`, which must keep the symlink
  path (never `realpath` it) or the bundler dedupes onto the module. (2)
  `src/web/text-imports.d.ts` must NOT be named `assets.d.ts`: a `.d.ts` beside
  a same-named `.ts` is taken as its declaration file and silently leaves the
  program. (3) A CSS rule setting `display` on an element toggled via the
  `hidden` attribute outranks the UA's `[hidden] { display: none }` — this
  hid nothing and left the modal backdrop swallowing every click. Add an
  explicit `#id[hidden] { display: none }` guard; `test/web-render.test.ts`
  asserts one exists.
- **Security:** control plane is loopback-only + bearer token (constant-time
  compare, rotated each start, never logged). Instances default to 127.0.0.1.
  `llamactl web` refuses to bind off-loopback without a session token.

## Conventions

- Strict TS, no `any` without a justifying comment. Typed errors only:
  `LlamactlError(code, message)` with stable `ErrorCode`s (`src/errors.ts`).
- `--json` contract: in JSON mode a command writes exactly one JSON document to
  stdout and nothing else.
- Match the surrounding style: top-of-file doc comments, focused helpers,
  comment density as in sibling files.
- These are normal app code, so `Date.now()` etc. are fine (unlike Workflow
  scripts).

## Gotchas

- **The binary is built by `scripts/build.ts`, not `bun build --compile`.** Solid
  JSX needs the `@opentui/solid` transform, which the bare CLI doesn't apply — so
  the build drives `Bun.build()` with the Solid plugin + `compile`. opentui's
  native renderer (`libopentui.so`, imported `with { type: "file" }`) is embedded
  into the binary by Bun and dlopen'd at runtime (verified working).
- The TUI is loaded via a dynamic `import("./tui/app.tsx")` in `index.ts` so
  headless paths and the compiled binary don't pay for Solid/opentui unless the
  TUI runs. Keep it that way.
- `src/discovery/models.ts` is reported as binary by `file(1)` (em-dashes in
  comments); grep with `-a` if needed.
- `readGgufMeta` only reads the first ~1 MiB of a file; arch/context_length sit
  before the tokenizer arrays, so that's enough. Unknown ⇒ null fallback.
- CPU temperature: on this dev box `k10temp` isn't loaded, so the CPU sensor is
  matched by hwmon **label** (`TSI0_TEMP` etc.), not driver name — see
  `src/monitor/proc.ts`.

## Testing approach

The web UI has four layers of coverage, because a buildless browser front end
has no compiler to catch anything: `test/web.test.ts` (proxy, auth, local
routes), `test/web-modules.test.ts` (every import resolves to a served module
and every named binding really is exported), `test/web-render.test.ts` (the
real browser modules executed against `test/helpers/fake-dom.ts`), and
`test/e2e.test.ts` (headless Chromium via Playwright — skipped unless
`LLAMACTL_E2E=1`, so plain `bun test` needs no browser). Reach for the e2e lane
for anything visual or interactive; the others can't see CSS or clicks.

`bun test`. Logic is unit-tested against a tiny fake `llama-server`
(`test/helpers/fake-llama-server.ts`) so no real model is needed. Monitor and
GGUF parsing expose pure helpers tested with fixtures/synthetic buffers. A couple
of supervisor crash/restart tests are timing-sensitive and can flake; re-run once
before assuming a real failure.
