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
  heads are detected by `{arch}.nextn_predict_layers` in the GGUF metadata —
  the exact key llama.cpp gates `--spec-type draft-mtp` on — with the published
  naming convention (`MTP/mtp-*.gguf`) as a fallback for when that key sits past
  our 1 MiB read window. `findMtpHead()` pairs a head to its base model (same
  repo + quant, then same repo, then proximity), and the supervisor uses it to
  auto-fill `specDraftModel` when a spec asks for `--spec-type draft-mtp`
  without naming a head. This matters because llama.cpp **fails soft** here: no
  head ⇒ one warning, then it serves with speculation silently disabled.
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
- **Security:** control plane is loopback-only + bearer token (constant-time
  compare, rotated each start, never logged). Instances default to 127.0.0.1.

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

`bun test`. Logic is unit-tested against a tiny fake `llama-server`
(`test/helpers/fake-llama-server.ts`) so no real model is needed. Monitor and
GGUF parsing expose pure helpers tested with fixtures/synthetic buffers. A couple
of supervisor crash/restart tests are timing-sensitive and can flake; re-run once
before assuming a real failure.
