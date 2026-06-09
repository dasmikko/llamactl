#!/usr/bin/env bun
/**
 * llamactl entry point. Parses argv, resolves effective config (defaults →
 * file → env → flags), and dispatches to a command handler. A hidden
 * `daemon __run` form (also triggered by LLAMACTL_DAEMON_CHILD=1) boots the
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
  cmdDownloads,
  cmdInit,
  cmdInstance,
  cmdList,
  cmdPs,
  cmdPull,
  cmdRecommend,
  cmdRm,
  cmdSearch,
  cmdStart,
  cmdStop,
  reportError,
} from "./cli/commands.ts";
import { runDaemonForeground } from "./daemon/daemon.ts";
import { VERSION } from "./version.ts";

const HELP = `llamactl ${VERSION} — a Bun-native launcher for local LLMs (llama-server)

Usage:
  llamactl <command> [options]

Run with no command to open the interactive TUI.

Commands:
  (none)               Open the interactive TUI
  list                 List discovered GGUF models
  start <model>        Start a model (auto-starts the daemon if needed)
  start --instance <id>  Start a saved instance profile
  stop <model>         Stop a running model
  rm <model> --yes     Delete a model's file(s) from disk
  ps                   Show running models (port, pid, uptime)
  instance ls|add|rm|edit   Manage saved launch profiles
  search <query>       Search Hugging Face for GGUF models
  pull <repo>[:quant]  Download a model from Hugging Face
  downloads [cancel <id>]   List or cancel downloads
  daemon start|stop    Start or stop the background supervisor
  init                 Interactive setup wizard          (planned)
  recommend            Suggest a model for your hardware  (planned)
  doctor               Diagnose your setup                (planned)

Options:
  --json               Machine-readable JSON output, nothing else
  --ctx <n>            Context size (--ctx-size)
  --ngl <n>            GPU layers to offload (--gpu-layers)
  --n-cpu-moe <n>      Keep first N layers' MoE expert weights on CPU
  --threads <n>        CPU threads
  --batch-size <n>     Batch size
  --flash-attn         Enable flash attention (--no-flash-attn to disable)
  --reasoning          Enable reasoning/thinking (--no-reasoning to disable)
  --jinja              Use the Jinja chat-template engine (--no-jinja to disable)
  --chat-template <t>  Override the chat template (built-in name or Jinja)
  --cache-type-k <t>   KV-cache quant for K (f16, q8_0, q4_0, …)
  --cache-type-v <t>   KV-cache quant for V (f16, q8_0, q4_0, …)
  --host <addr>        Bind host for the instance (default 127.0.0.1)
  --port <n>           Pin the instance port (default: auto)
  --extra-args "<a b>" Extra llama-server args, space-separated
  --name <id>          Name for 'instance add'
  --control-port <n>   Control-plane base port (default 48134)
  --llama-server <p>   Path to the llama-server binary
  --model-paths <a:b>  Extra colon-separated model directories
  --config <path>      Use an alternate config file
  -h, --help           Show this help
  -v, --version        Show version
`;

/** Translate parsed CLI flags into a PartialConfig override layer. */
function flagsToConfig(a: ParsedArgs): PartialConfig {
  const out: PartialConfig = {};
  const controlPort = numOpt(a, "control-port");
  if (controlPort !== undefined) out.controlPort = controlPort;
  const llama = strOpt(a, "llama-server");
  if (llama !== undefined) out.llamaServerPath = llama;
  const ctx = numOpt(a, "ctx");
  if (ctx !== undefined) out.defaultCtx = ctx;
  const paths = strOpt(a, "model-paths");
  if (paths !== undefined) out.modelPaths = paths.split(":").filter((p) => p.length > 0);
  return out;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  // Detached daemon child: boot the supervisor in the foreground and park.
  const isDaemonChild =
    process.env.LLAMACTL_DAEMON_CHILD === "1" || (argv[0] === "daemon" && argv[1] === "__run");
  if (isDaemonChild) {
    const a = parseArgs(argv);
    const config = await resolveConfig({ flags: flagsToConfig(a), configFile: strOpt(a, "config") });
    await runDaemonForeground(config);
    return 0; // unreachable; runDaemonForeground parks the loop
  }

  const a = parseArgs(argv);

  if (a.options.help === true || a.options.h === true) {
    emitLine(HELP);
    return 0;
  }
  if (a.options.version === true || a.options.v === true) {
    emitLine(VERSION);
    return 0;
  }

  const mode = detectOutputMode(boolOpt(a, "json"));
  const command = a.positionals[0];

  // No command → open the interactive TUI. The TUI module is loaded lazily so
  // headless commands and the compiled binary never pull React/Ink into their
  // path unless the TUI is actually requested.
  if (command === undefined) {
    try {
      const config = await resolveConfig({ flags: flagsToConfig(a), configFile: strOpt(a, "config") });
      const { runTui } = await import("./tui/app.tsx");
      await runTui(config);
      return 0;
    } catch (e) {
      return reportError(e, mode);
    }
  }

  try {
    const config = await resolveConfig({ flags: flagsToConfig(a), configFile: strOpt(a, "config") });
    switch (command) {
      case "list":
        return await cmdList(config, mode);
      case "start":
        return await cmdStart(a, config, mode);
      case "stop":
        return await cmdStop(a, config, mode);
      case "rm":
        return await cmdRm(a, config, mode);
      case "ps":
        return await cmdPs(config, mode);
      case "instance":
        return await cmdInstance(a, config, mode);
      case "search":
        return await cmdSearch(a, config, mode);
      case "pull":
        return await cmdPull(a, config, mode);
      case "downloads":
        return await cmdDownloads(a, config, mode);
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
        emitError(`unknown command: ${command}\nRun 'llamactl --help' for usage.`);
        return 1;
    }
  } catch (e) {
    return reportError(e, mode);
  }
}

process.exit(await main());
