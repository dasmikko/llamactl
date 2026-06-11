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
import { loadFavoriteStore } from "../favorites/store.ts";
import { DownloadManager } from "../hf/download.ts";
import { InstallManager } from "../llama/install.ts";
import { readHfTokenFromCache } from "../hf/client.ts";
import { startControlPlane } from "./controlplane.ts";
import { generateToken, writeRuntime, clearRuntime } from "./runtime.ts";
import { logsDir, installsDir, installsRegistryPath } from "../config/paths.ts";
import { modelScanPaths } from "../config/config.ts";
import { mkdir } from "node:fs/promises";

/**
 * Resolve the llama-server binary to spawn. Precedence:
 *   1. explicit `config.llamaServerPath` override
 *   2. the active managed install's binary (`activeBinPath`)
 *   3. PATH lookup; else the bare name (supervisor surfaces a typed error).
 */
function resolveLlamaServer(config: Config, activeBinPath: string | null): string {
  if (config.llamaServerPath) return config.llamaServerPath;
  if (activeBinPath) return activeBinPath;
  const onPath = Bun.which("llama-server");
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
  const scanPaths = modelScanPaths(config);
  let currentModels: Model[] = await discoverModels({ extraPaths: scanPaths });
  const resolver: ModelResolver = {
    resolve: (sel) => resolveModel(currentModels, sel),
    all: () => currentModels,
  };
  const stopWatch = watchModels({ extraPaths: scanPaths }, (m) => {
    currentModels = m;
  });
  // Re-run discovery on demand (e.g. when a download finishes) so a new model
  // appears immediately, without waiting on a filesystem-watch event.
  const refreshModels = (): void => {
    void discoverModels({ extraPaths: scanPaths })
      .then((m) => {
        currentModels = m;
      })
      .catch(() => {});
  };

  // Managed llama.cpp installs. The active install (if any) supplies the
  // binary the supervisor spawns; switching it affects subsequent (re)starts.
  const installs = await InstallManager.load({
    installsDir: installsDir(),
    registryPath: installsRegistryPath(),
    initialActiveId: config.activeInstall,
  });

  const supervisor = new Supervisor({
    config,
    resolver,
    logsDir: logsDir(),
    llamaServerPath: () =>
      resolveLlamaServer(config, installs.getActive()?.binPath ?? null),
  });

  const instances = await loadInstanceStore();
  const favorites = await loadFavoriteStore();
  const sampler = new Sampler({ supervisor });
  sampler.start();

  // Hugging Face downloads land in the (scanned) download dir; the watcher above
  // picks up finished files live. Token: explicit config, else the HF CLI cache.
  await mkdir(config.downloadDir, { recursive: true });
  const getHfToken = async (): Promise<string | null> =>
    config.hfToken ?? (await readHfTokenFromCache());
  const downloads = new DownloadManager({
    destDir: () => config.downloadDir,
    getToken: getHfToken,
    onComplete: () => refreshModels(),
  });

  const startedAt = Date.now();
  const token = generateToken();

  let shuttingDown = false;

  const control = await startControlPlane({
    token,
    supervisor,
    instances,
    favorites,
    sampler,
    downloads,
    installs,
    getHfToken,
    models: () => currentModels,
    refreshModels: () => refreshModels(),
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
