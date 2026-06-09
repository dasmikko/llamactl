# Build Prompt: `bunstash` — a Bun-native local LLM launcher

You are building a fast, terminal-native launcher for local LLMs that run via
`llama-server` (from llama.cpp). It is, in one Bun executable: a **CLI**, a
**background daemon/supervisor**, and an **OpenAI-compatible reverse proxy**.
Think of it as a transparent, zero-overhead wrapper around `llama-server` — not
another model-packaging ecosystem.

Build incrementally. Get each phase working and tested before moving on. Ask me
before introducing any heavy dependency; prefer Bun built-ins.

---

## Non-negotiable constraints

- **Runtime:** Bun (latest). Use Bun built-ins wherever possible: `Bun.serve`,
  `Bun.spawn`, `Bun.file`, `Bun.write`, built-in `fs.watch`. Avoid Express,
  node-fetch, and similar — they're unnecessary here.
- **Language:** TypeScript, strict mode on. No `any` unless justified in a comment.
- **Distribution:** must compile to a single executable via `bun build --compile`.
  Keep this working at every phase — no top-level use of APIs that break the
  compiled target.
- **Zero overhead:** the proxy spawns the *unmodified* upstream `llama-server`.
  Do not reimplement inference. The proxy must add no measurable latency beyond
  a forwarding hop — stream responses through, never buffer whole bodies.
- **Security default: loopback only.** The proxy and control plane bind to
  `127.0.0.1` by default. LAN binding (`0.0.0.0`) must be an explicit,
  off-by-default opt-in (see Phase 6) and must print a clear warning when used,
  because the proxy has no auth.

---

## Architecture overview

Three personas, one binary:

1. **CLI** — what the user types (`bunstash start qwen-coder`, `bunstash list`).
   Talks to the daemon over the loopback control plane. If no daemon is running,
   it forks/exec's one and retries once.
2. **Daemon (supervisor)** — long-running. Owns child `llama-server` processes,
   the control plane, and the proxy. Writes a `runtime.json` on startup with the
   control-plane URL + a fresh bearer token.
3. **Proxy** — loopback HTTP listener exposing OpenAI-compatible endpoints.
   Routes by model name, auto-starts an unloaded model on first request.

### State / files (respect XDG on Unix, sane equivalents on Windows/macOS)
- `runtime.json` in the state dir (e.g. `$XDG_STATE_HOME/bunstash/`), mode `0600`.
  Contains: control-plane URL, bearer token, daemon PID. Token is 32 random
  bytes from `crypto.getRandomValues`, **rotated on every daemon start**.
- Per-launch logs in the cache dir: `logs/<model-id>-<timestamp>.log`.
- A user config file (`config.json` or TOML) for defaults: ports, model paths,
  `ollama_compat`, `fallback_enabled`, etc.

### Two separate listeners (keep them structurally independent)
- **Control plane:** loopback HTTP on `127.0.0.1:48134` (scan upward a few ports
  if taken). Every route except `GET /health` requires the bearer token,
  validated in constant time. Request/response bodies are JSON.
- **Proxy:** loopback HTTP, **no auth, no TLS** (single-user local threat model).
  Default port `11435`. In ollama-compat mode, `11434`.

Keeping these two separate now is what makes a future LAN-binding feature for the
proxy safe without touching the control plane.

---

## Build phases

### Phase 1 — CLI skeleton + config
- Arg parsing (Bun's `process.argv` or a tiny parser; ask before adding a lib).
- Commands stubbed: `init`, `list`, `start`, `stop`, `ps`, `daemon start|stop`,
  `recommend`, `doctor`.
- Load/merge config: defaults → config file → env (`BUNSTASH_*`) → flags.
- `--json` flag contract: when set, output machine-readable JSON and nothing else
  (no spinners, no color, no preamble). This is the agent-facing interface.

### Phase 2 — Model discovery
- Scan known caches for `.gguf` files: `~/.cache/huggingface/`,
  `~/.ollama/models`, `~/.lmstudio/models`, plus any configured paths.
- Derive a canonical id + friendly name; capture size, quantization (from
  filename heuristics), and path.
- `bunstash list` renders a padded table on a TTY, TSV when piped, full JSON
  under `--json`.
- Live watch: new downloads appear without restart (`fs.watch` / chokidar only
  if needed — ask first).

### Phase 3 — Daemon + control plane
- `bunstash daemon start` detaches and runs the supervisor.
- On startup: pick control-plane port, generate token, write `runtime.json`
  (`0600`), start `GET /health` + token-guarded JSON-RPC-ish routes.
- CLI attach logic: read `runtime.json`; if absent/stale, spawn daemon, poll for
  fresh `runtime.json`, retry once. Detect stale files via PID liveness check.
- Constant-time token comparison (`crypto.timingSafeEqual`-style).

### Phase 4 — Process supervision
- `start <model>` resolves a model (by name, substring, path, or id) and spawns
  `llama-server` with resolved flags (`--ctx`, port, etc.). Use a configurable
  `--llama-server` path; fall back to one on `PATH`.
- Track child PID + assigned port in daemon state. Stream child stdout/stderr to
  the per-launch log file.
- Crash handling: restart with a **retry cap** (e.g. 3 within a window); after
  the cap, surface a clear typed error instead of looping.
- `stop <model>`, `ps` (list running models + ports + uptime).

### Phase 5 — OpenAI-compatible proxy
- `Bun.serve` listener on the proxy port. Forward `/v1/chat/completions`,
  `/v1/completions`, `/v1/embeddings`, `/v1/models` to the right child by model.
- **Streaming:** pass SSE / chunked responses straight through. Never buffer the
  whole body.
- **Auto-start on first request:** if the requested model isn't running, start it
  (Phase 4), wait for readiness (poll its `/health`), then serve.
- **Fallback with audit headers:** if a launch fails and `fallback_enabled` is
  true, route to a ready peer model and add response headers
  `x-bunstash-served-by` and `x-bunstash-fallback-reason`. If disabled, hard-fail
  with a clear error.

### Phase 6 — LAN exposure (explicit opt-in)
- A flag/config (`--host 0.0.0.0` / `proxy.host`) that lets the **proxy only**
  bind to a non-loopback address. Default stays `127.0.0.1`.
- When binding off-loopback, print a prominent warning that the endpoint is
  unauthenticated and recommend fronting it with a reverse proxy (auth + TLS).
- The control plane must **never** be bindable off-loopback.

### Phase 7 — Ollama-compat mode (opt-in)
- `--ollama-compat` / `BUNSTASH_OLLAMA_COMPAT=1`: proxy claims port `11434`,
  answers `GET /` with the exact `"Ollama is running"` string, and serves the
  discovery surface: `GET /api/tags`, `/api/version`, `/api/ps`, `POST /api/show`.
- Do NOT implement Ollama's inference endpoints; clients fall through to the
  OpenAI-compat routes. Off by default → port `11435`, identity `"bunstash is running"`.

### Phase 8 (optional, later) — `init` wizard, `recommend`, `doctor`, TUI
- `init`: interactive — offer to install/locate `llama-server`, pick a starter
  GGUF, write a tuned config, smoke-launch. Use exit codes: `72` aborted-safe,
  `73` download-failed, `74` smoke-failed.
- `doctor`: compare live setup against config, emit typed findings.
- TUI: defer until the CLI is solid. When you do it, use **Ink**; keyboard-first
  (vim-style hjkl, `/` filter, `?` help); panes for Logs / Chat / Embed that hit
  the same proxy endpoint external clients use. Discuss with me before starting.

---

## Quality bar

- **Errors are typed and actionable.** No silent failures, no infinite restart
  loops, no leaked child processes (clean up on daemon exit and on SIGINT/SIGTERM).
- **Tests:** use `bun test`. Cover model-id resolution, config merging,
  port-scan fallback, stale-`runtime.json` detection, and proxy routing/fallback.
  Mock `llama-server` with a tiny fake HTTP server in tests.
- **No secrets logged.** Never write the bearer token to logs or stdout.
- **`bun build --compile` must succeed and run** at the end of every phase.

## Deliverables for the first pass
Phases 1–5, compiling to a single executable, with tests for the logic in 2–5
and a short `README.md` covering install, `list`, `start`, and pointing a client
at the proxy. Stop after Phase 5 and check in with me before Phases 6–8.

Start by proposing the project layout and the `package.json` / `tsconfig.json`,
then implement Phase 1.
