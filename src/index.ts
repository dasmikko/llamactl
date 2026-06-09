#!/usr/bin/env bun
/**
 * bunstash entry point. Parses argv, resolves effective config (defaults →
 * file → env → flags), and dispatches to a command handler. A hidden
 * `daemon __run` form (also triggered by BUNSTASH_DAEMON_CHILD=1) boots the
 * supervisor in the foreground — this is what the detached daemon process runs.
 */

import type { PartialConfig } from "./config/config.ts";
import { resolveConfig } from "./config/config.ts";
import { boolOpt, numOpt, parseArgs, strOpt, type ParsedArgs } from "./cli/args.ts";
import { detectOutputMode, emitError, emitLine } from "./cli/output.ts";
import {
  cmdDaemonStart,
  cmdDaemonStop,
  cmdDoctor,
  cmdInit,
  cmdList,
  cmdPs,
  cmdRecommend,
  cmdStart,
  cmdStop,
  reportError,
} from "./cli/commands.ts";
import { runDaemonForeground } from "./daemon/daemon.ts";

const VERSION = "0.1.0";

const HELP = `bunstash ${VERSION} — a Bun-native launcher for local LLMs (llama-server)

Usage:
  bunstash <command> [options]

Commands:
  list                 List discovered GGUF models
  start <model>        Start a model (auto-starts the daemon if needed)
  stop <model>         Stop a running model
  ps                   Show running models (port, pid, uptime)
  daemon start|stop    Start or stop the background supervisor
  init                 Interactive setup wizard          (planned)
  recommend            Suggest a model for your hardware  (planned)
  doctor               Diagnose your setup                (planned)

Options:
  --json               Machine-readable JSON output, nothing else
  --ctx <n>            Context size for start
  --host <addr>        Proxy bind host (LAN exposure lands in a later phase)
  --port <n>           Proxy port (default 11435, or 11434 in ollama-compat)
  --control-port <n>   Control-plane base port (default 48134)
  --llama-server <p>   Path to the llama-server binary
  --model-paths <a:b>  Extra colon-separated model directories
  --ollama-compat      Claim Ollama's port/identity (later phase)
  --fallback           Allow proxy fallback to a ready peer model
  --config <path>      Use an alternate config file
  -h, --help           Show this help
  -v, --version        Show version
`;

/** Translate parsed CLI flags into a PartialConfig override layer. */
function flagsToConfig(a: ParsedArgs): PartialConfig {
  const out: PartialConfig = {};
  const host = strOpt(a, "host");
  const port = numOpt(a, "port");
  if (host !== undefined || port !== undefined) {
    out.proxy = {};
    if (host !== undefined) out.proxy.host = host;
    if (port !== undefined) out.proxy.port = port;
  }
  const controlPort = numOpt(a, "control-port");
  if (controlPort !== undefined) out.controlPort = controlPort;
  const llama = strOpt(a, "llama-server");
  if (llama !== undefined) out.llamaServerPath = llama;
  const ctx = numOpt(a, "ctx");
  if (ctx !== undefined) out.defaultCtx = ctx;
  if (boolOpt(a, "ollama-compat")) out.ollamaCompat = true;
  if (a.options.fallback === true) out.fallbackEnabled = true;
  if (a.options.fallback === false) out.fallbackEnabled = false;
  const paths = strOpt(a, "model-paths");
  if (paths !== undefined) out.modelPaths = paths.split(":").filter((p) => p.length > 0);
  return out;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  // Detached daemon child: boot the supervisor in the foreground and park.
  const isDaemonChild =
    process.env.BUNSTASH_DAEMON_CHILD === "1" || (argv[0] === "daemon" && argv[1] === "__run");
  if (isDaemonChild) {
    const a = parseArgs(argv);
    const config = await resolveConfig({ flags: flagsToConfig(a), configFile: strOpt(a, "config") });
    await runDaemonForeground(config);
    return 0; // unreachable; runDaemonForeground parks the loop
  }

  const a = parseArgs(argv);

  if (a.options.help === true || a.options.h === true || argv.length === 0) {
    emitLine(HELP);
    return argv.length === 0 ? 1 : 0;
  }
  if (a.options.version === true || a.options.v === true) {
    emitLine(VERSION);
    return 0;
  }

  const mode = detectOutputMode(boolOpt(a, "json"));
  const command = a.positionals[0];

  try {
    const config = await resolveConfig({ flags: flagsToConfig(a), configFile: strOpt(a, "config") });
    switch (command) {
      case "list":
        return await cmdList(config, mode);
      case "start":
        return await cmdStart(a, config, mode);
      case "stop":
        return await cmdStop(a, config, mode);
      case "ps":
        return await cmdPs(config, mode);
      case "daemon": {
        const sub = a.positionals[1];
        if (sub === "start") return await cmdDaemonStart(config, mode);
        if (sub === "stop") return await cmdDaemonStop(mode);
        emitError(`unknown daemon subcommand: ${sub ?? "(none)"} — use 'start' or 'stop'`);
        return 1;
      }
      case "init":
        return cmdInit(mode);
      case "recommend":
        return cmdRecommend(mode);
      case "doctor":
        return cmdDoctor(mode);
      default:
        emitError(`unknown command: ${command}\nRun 'bunstash --help' for usage.`);
        return 1;
    }
  } catch (e) {
    return reportError(e, mode);
  }
}

process.exit(await main());
