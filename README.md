# bunstash

A fast, terminal-native launcher for local LLMs that run via
[`llama-server`](https://github.com/ggml-org/llama.cpp) (from llama.cpp).

It's one Bun executable wearing three hats:

- **CLI** — what you type (`bunstash start qwen-coder`, `bunstash list`).
- **Daemon (supervisor)** — a long-running process that owns the child
  `llama-server` processes, a loopback control plane, and the proxy.
- **Proxy** — a loopback, OpenAI-compatible reverse proxy that routes by model
  name and auto-starts a model on first request.

bunstash is a transparent, zero-overhead wrapper around the *unmodified*
upstream `llama-server` — it does not reimplement inference and it streams
responses straight through.

> **Security default: loopback only.** The proxy and control plane bind to
> `127.0.0.1`. The proxy has no auth by design (single-user local threat model);
> LAN exposure is an explicit, off-by-default opt-in (a later phase).

---

## Requirements

- [Bun](https://bun.sh) (latest; developed against 1.3.x)
- A `llama-server` binary on your `PATH`, or point bunstash at one with
  `--llama-server /path/to/llama-server` (or `BUNSTASH_LLAMA_SERVER`).

## Install / build

Run straight from source:

```sh
bun install
bun run src/index.ts list
```

Or compile to a single self-contained executable:

```sh
bun run build          # produces ./bunstash
./bunstash list
```

## Quick start

```sh
# 1. See what GGUF models bunstash can find on disk
bunstash list

# 2. Start one (auto-starts the background daemon if it isn't running)
bunstash start qwen3

# 3. See what's running (ports, pids, uptime)
bunstash ps

# 4. Point any OpenAI-compatible client at the proxy
curl http://127.0.0.1:11435/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3","messages":[{"role":"user","content":"hello"}]}'
```

You don't actually have to `start` a model first — the proxy **auto-starts** an
unloaded model on the first request for it, waits for its `/health` to go green,
then serves. `start` is just there for when you want it warm ahead of time.

## Commands

| Command | What it does |
| --- | --- |
| `bunstash list` | List discovered GGUF models (padded table on a TTY, TSV when piped, JSON with `--json`). |
| `bunstash start <model>` | Resolve a model (by id, name, substring, or path) and start it. |
| `bunstash stop <model>` | Stop a running model. |
| `bunstash ps` | Show running models with ports, pids, uptime, restarts. |
| `bunstash daemon start` | Start the background supervisor explicitly. |
| `bunstash daemon stop` | Stop the supervisor and all its children. |
| `bunstash init` / `recommend` / `doctor` | Planned (later phases). |

### Model selectors

`start` / `stop` accept anything that unambiguously identifies a model:

- the canonical **id** (`qwen3.5-9b-q4_k_m`)
- an exact **path** to a `.gguf` file
- an exact **name** (case-insensitive)
- a **substring** of the id or name — if it matches exactly one model

An ambiguous substring lists the candidates instead of guessing.

## The `--json` contract

Pass `--json` to any command and the **only** thing written to stdout is a
single machine-readable JSON document — no colors, no spinners, no preamble.
This is the agent-facing interface. Errors are emitted as a typed envelope:

```json
{ "error": { "code": "model_not_found", "message": "no model matches 'qwen99'" } }
```

## Configuration

Precedence, lowest to highest:

```
built-in defaults  →  config file  →  environment (BUNSTASH_*)  →  CLI flags
```

Config file (JSON) location follows XDG: `$XDG_CONFIG_HOME/bunstash/config.json`
(falling back to `~/.config/bunstash/config.json`). Example:

```json
{
  "modelPaths": ["/srv/models"],
  "defaultCtx": 8192,
  "fallbackEnabled": true,
  "llamaServerPath": "/usr/local/bin/llama-server"
}
```

| Setting | Env var | Flag | Default |
| --- | --- | --- | --- |
| Extra model dirs | `BUNSTASH_MODEL_PATHS` (`:`-separated) | `--model-paths a:b` | — |
| Control-plane port | `BUNSTASH_CONTROL_PORT` | `--control-port` | `48134` (scans up) |
| Proxy host | `BUNSTASH_PROXY_HOST` | `--host` | `127.0.0.1` |
| Proxy port | `BUNSTASH_PROXY_PORT` | `--port` | `11435` |
| Default context size | `BUNSTASH_CTX` | `--ctx` | `4096` |
| `llama-server` path | `BUNSTASH_LLAMA_SERVER` | `--llama-server` | from `PATH` |
| Fallback to a ready peer | `BUNSTASH_FALLBACK` | `--fallback` | off |
| Ollama-compat mode | `BUNSTASH_OLLAMA_COMPAT` | `--ollama-compat` | off |

bunstash scans `~/.cache/huggingface/`, `~/.ollama/models`, and
`~/.lmstudio/models` for `.gguf` files automatically, plus any `modelPaths` you
add. New downloads are picked up live without a restart.

## How it fits together

```
        bunstash CLI ──(loopback HTTP + bearer token)──► Control plane ─┐
                                                                        │
  OpenAI client ──(loopback HTTP, no auth)──► Proxy ──► Supervisor ◄────┘
                                                 │
                                                 └─► llama-server child(ren)
```

- **runtime.json** (mode `0600`, in `$XDG_STATE_HOME/bunstash/`) holds the
  control-plane URL, proxy URL, daemon PID, and a fresh bearer token that is
  **rotated on every daemon start**. The token is never logged.
- The **control plane** (`127.0.0.1:48134`, scanning upward) requires the bearer
  token on every route except `GET /health`, compared in constant time. It is
  hard-wired to loopback and is never bindable off-host.
- The **proxy** (`127.0.0.1:11435`) is intentionally separate. Forwarded routes:
  `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/models`.
  Streaming (SSE / chunked) responses pass straight through, never buffered.
- **Fallback** (opt-in): if a launch fails and `fallbackEnabled` is set, the
  proxy routes to a ready peer model and stamps the response with
  `x-bunstash-served-by` and `x-bunstash-fallback-reason`. Disabled → it hard-
  fails with a typed error.

Per-launch logs land in `$XDG_CACHE_HOME/bunstash/logs/<model-id>-<ts>.log`.

## Development

```sh
bun test                 # run the test suite
bun run typecheck        # tsc --noEmit (strict)
bun run build            # compile ./bunstash
```

Tests cover model-id resolution, config merging, port-scan fallback,
stale-`runtime.json` detection, process supervision (readiness, crash/restart
cap), control-plane auth/routing, and proxy routing/streaming/fallback — using a
tiny fake `llama-server` so no real model is needed.

## Status

Phases 1–5 are implemented: CLI + config, model discovery, daemon + control
plane, process supervision, and the OpenAI-compatible proxy. LAN exposure,
Ollama-compat mode, and the `init`/`recommend`/`doctor`/TUI work are planned for
later phases.
