/**
 * The daemon (supervisor process) entry point. Owns the child llama-server
 * processes, the loopback control plane, and the resource sampler. On startup
 * it writes a fresh runtime.json (mode 0600) with a rotated bearer token, then
 * runs until a signal or a /shutdown request tears everything down cleanly.
 */

import type { Config, Model, ModelResolver, Runtime } from "../types.ts";
import { discoverModels, resolveModel, watchModels } from "../discovery/models.ts";
import { Supervisor } from "../supervisor/process.ts";
import { Sampler } from "../monitor/sampler.ts";
import { loadInstanceStore } from "../instances/store.ts";
import { startControlPlane } from "./controlplane.ts";
import { generateToken, writeRuntime, clearRuntime } from "./runtime.ts";
import { logsDir } from "../config/paths.ts";
import { mkdir } from "node:fs/promises";

/** Resolve the llama-server binary path: explicit config, else PATH lookup. */
function resolveLlamaServer(config: Config): string {
  if (config.llamaServerPath) return config.llamaServerPath;
  const onPath = Bun.which("llama-server");
  // Fall back to the bare name; the supervisor surfaces a typed error if absent.
  return onPath ?? "llama-server";
}

export interface RunDaemonResult {
  controlUrl: string;
  stop: () => Promise<void>;
}

/**
 * Boot the daemon in the current process. Resolves once everything is listening
 * and runtime.json is written. Installs signal handlers for clean teardown.
 */
export async function runDaemon(config: Config): Promise<RunDaemonResult> {
  await mkdir(logsDir(), { recursive: true });

  // Live model list: discovery refreshes it; resolver and proxy read it through
  // closures so new downloads are picked up without a restart.
  let currentModels: Model[] = await discoverModels({ extraPaths: config.modelPaths });
  const resolver: ModelResolver = {
    resolve: (sel) => resolveModel(currentModels, sel),
    all: () => currentModels,
  };
  const stopWatch = watchModels({ extraPaths: config.modelPaths }, (m) => {
    currentModels = m;
  });

  const supervisor = new Supervisor({
    config,
    resolver,
    logsDir: logsDir(),
    llamaServerPath: resolveLlamaServer(config),
  });

  const instances = await loadInstanceStore();
  const sampler = new Sampler({ supervisor });
  sampler.start();

  const startedAt = Date.now();
  const token = generateToken();

  let shuttingDown = false;

  const control = await startControlPlane({
    token,
    supervisor,
    instances,
    sampler,
    models: () => currentModels,
    startPort: config.controlPort,
    pid: process.pid,
    startedAt,
    onShutdown: () => void stop(),
  });

  const runtime: Runtime = {
    controlUrl: control.url,
    token,
    pid: process.pid,
    startedAt,
  };
  await writeRuntime(runtime);

  const stop = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopWatch();
    sampler.stop();
    control.stop();
    await supervisor.shutdownAll();
    await clearRuntime();
  };

  // Clean teardown on signals — no leaked child processes.
  const onSignal = () => {
    void stop().then(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  return { controlUrl: control.url, stop };
}

/**
 * Run the daemon and block forever (used by the detached child process). Keeps
 * the event loop alive until a signal or /shutdown calls process.exit.
 */
export async function runDaemonForeground(config: Config): Promise<void> {
  await runDaemon(config);
  // Park the event loop; teardown happens via signal/shutdown handlers.
  await new Promise<never>(() => {});
}
