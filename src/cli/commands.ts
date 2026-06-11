/**
 * CLI command handlers. Each respects the --json contract: in JSON mode the
 * only stdout output is one machine-readable document. Human mode renders a
 * padded table on a TTY, TSV when piped.
 */

import type {
  BuildRequest,
  Config,
  Download,
  DownloadsResponse,
  HfFile,
  HfFilesResponse,
  HfRepo,
  HfSearchResponse,
  InstallsResponse,
  InstanceConfig,
  InstancesResponse,
  LaunchSpec,
  LlamaBackend,
  LlamaInstall,
  Model,
  RunningModel,
  PsResponse,
} from "../types.ts";
import { LlamactlError, isLlamactlError } from "../errors.ts";
import { discoverModels, resolveModel, runnableModels } from "../discovery/models.ts";
import { modelScanPaths } from "../config/config.ts";
import { connectDaemon, currentRuntime, clientFor } from "./../daemon/client.ts";
import { readLiveRuntime, isProcessAlive, clearRuntime } from "../daemon/runtime.ts";
import {
  type Column,
  type OutputMode,
  emitError,
  emitJson,
  emitLine,
  humanBytes,
  humanUptime,
  renderTable,
} from "./output.ts";
import { type ParsedArgs, numOpt, strOpt, boolOpt } from "./args.ts";

/** Build a LaunchSpec from a model selector and the start/instance CLI flags. */
function flagsToSpec(model: string, args: ParsedArgs): LaunchSpec {
  const spec: LaunchSpec = { model };
  const ctx = numOpt(args, "ctx");
  if (ctx !== undefined) spec.ctxSize = ctx;
  const ngl = numOpt(args, "ngl") ?? numOpt(args, "gpu-layers");
  if (ngl !== undefined) spec.gpuLayers = ngl;
  const ncmoe = numOpt(args, "n-cpu-moe") ?? numOpt(args, "ncmoe");
  if (ncmoe !== undefined) spec.nCpuMoe = ncmoe;
  const threads = numOpt(args, "threads");
  if (threads !== undefined) spec.threads = threads;
  const batch = numOpt(args, "batch-size");
  if (batch !== undefined) spec.batchSize = batch;
  const ubatch = numOpt(args, "ubatch-size");
  if (ubatch !== undefined) spec.ubatchSize = ubatch;
  const parallel = numOpt(args, "parallel");
  if (parallel !== undefined) spec.parallel = parallel;
  const alias = strOpt(args, "alias");
  if (alias !== undefined) spec.alias = alias;
  const mmproj = strOpt(args, "mmproj");
  if (mmproj !== undefined) spec.mmproj = mmproj;
  if (args.options["flash-attn"] === true) spec.flashAttn = "on";
  else if (args.options["flash-attn"] === false) spec.flashAttn = "off";
  if (args.options["reasoning"] === true) spec.reasoning = "on";
  else if (args.options["reasoning"] === false) spec.reasoning = "off";
  if (args.options["jinja"] === true) spec.jinja = "on";
  else if (args.options["jinja"] === false) spec.jinja = "off";
  if (args.options["mlock"] === true) spec.mlock = "on";
  else if (args.options["mlock"] === false) spec.mlock = "off";
  // --no-mmap disables memory-mapping; --mmap re-asserts the default (on).
  if (args.options["mmap"] === false) spec.mmap = "off";
  else if (args.options["mmap"] === true) spec.mmap = "on";
  const ctk = strOpt(args, "cache-type-k");
  if (ctk !== undefined) spec.cacheTypeK = ctk;
  const ctv = strOpt(args, "cache-type-v");
  if (ctv !== undefined) spec.cacheTypeV = ctv;
  const tmpl = strOpt(args, "chat-template");
  if (tmpl !== undefined) spec.chatTemplate = tmpl;
  const host = strOpt(args, "host");
  if (host !== undefined) spec.host = host;
  const port = numOpt(args, "port");
  if (port !== undefined) spec.port = port;
  const extra = strOpt(args, "extra-args");
  if (extra !== undefined) spec.extraArgs = extra.split(/\s+/).filter((s) => s.length > 0);
  return spec;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ------------------------------- list ------------------------------------ */

export async function cmdList(config: Config, mode: OutputMode): Promise<number> {
  const models = runnableModels(
    await discoverModels({ extraPaths: modelScanPaths(config) }),
  );
  models.sort((a, b) => a.id.localeCompare(b.id));

  if (mode.json) {
    emitJson({ models });
    return 0;
  }

  if (models.length === 0) {
    emitLine("No GGUF models found. Add paths in your config or download one.");
    return 0;
  }

  const columns: Column<Model>[] = [
    { header: "ID", get: (m) => m.id },
    { header: "NAME", get: (m) => m.name },
    { header: "QUANT", get: (m) => m.quant ?? "-" },
    { header: "SIZE", get: (m) => humanBytes(m.sizeBytes), alignRight: true },
    { header: "SOURCE", get: (m) => m.source },
  ];
  emitLine(renderTable(models, columns, mode));
  return 0;
}

/* ------------------------------- start ----------------------------------- */

export async function cmdStart(args: ParsedArgs, config: Config, mode: OutputMode): Promise<number> {
  const instance = strOpt(args, "instance");
  const selector = args.positionals[1];
  if (!instance && !selector) {
    throw new LlamactlError("bad_request", "usage: llamactl start <model> [flags]  |  llamactl start --instance <id>");
  }

  const body = instance ? { instance } : { spec: flagsToSpec(selector!, args) };
  const conn = await connectDaemon({ config });
  const running = await conn.request<RunningModel>("POST", "/start", body);

  if (mode.json) {
    emitJson(running);
    return 0;
  }
  emitLine(`Started ${running.name} (${running.modelId}) on http://127.0.0.1:${running.port} [pid ${running.pid}]`);
  return 0;
}

/* ------------------------------ instance --------------------------------- */

export async function cmdInstance(args: ParsedArgs, config: Config, mode: OutputMode): Promise<number> {
  const sub = args.positionals[1];
  switch (sub) {
    case "ls":
    case "list":
      return cmdInstanceList(config, mode);
    case "add":
      return cmdInstanceAdd(args, config, mode);
    case "rm":
    case "remove":
      return cmdInstanceRemove(args, config, mode);
    case "edit":
      return cmdInstanceEdit(args, config, mode);
    default:
      throw new LlamactlError(
        "bad_request",
        `unknown instance subcommand: ${sub ?? "(none)"} — use ls | add | rm | edit`,
      );
  }
}

async function cmdInstanceList(config: Config, mode: OutputMode): Promise<number> {
  const conn = await connectDaemon({ config });
  const { instances } = await conn.request<InstancesResponse>("GET", "/instances");

  if (mode.json) {
    emitJson({ instances });
    return 0;
  }
  if (instances.length === 0) {
    emitLine("No saved instances. Create one with 'llamactl instance add <model> --name <id>'.");
    return 0;
  }
  const columns: Column<InstanceConfig>[] = [
    { header: "ID", get: (i) => i.id },
    { header: "NAME", get: (i) => i.name },
    { header: "MODEL", get: (i) => i.spec.model },
    { header: "CTX", get: (i) => (i.spec.ctxSize != null ? String(i.spec.ctxSize) : "-"), alignRight: true },
    { header: "NGL", get: (i) => (i.spec.gpuLayers != null ? String(i.spec.gpuLayers) : "-"), alignRight: true },
    { header: "PORT", get: (i) => (i.spec.port != null ? String(i.spec.port) : "auto"), alignRight: true },
  ];
  emitLine(renderTable(instances, columns, mode));
  return 0;
}

async function cmdInstanceAdd(args: ParsedArgs, config: Config, mode: OutputMode): Promise<number> {
  const model = args.positionals[2];
  if (!model) throw new LlamactlError("bad_request", "usage: llamactl instance add <model> [--name <id>] [flags]");
  const name = strOpt(args, "name");
  const spec = flagsToSpec(model, args);

  const conn = await connectDaemon({ config });
  const created = await conn.request<InstanceConfig>("POST", "/instances", { name, spec });

  if (mode.json) {
    emitJson(created);
    return 0;
  }
  emitLine(`Saved instance "${created.id}" for model ${created.spec.model}.`);
  return 0;
}

async function cmdInstanceRemove(args: ParsedArgs, config: Config, mode: OutputMode): Promise<number> {
  const id = args.positionals[2];
  if (!id) throw new LlamactlError("bad_request", "usage: llamactl instance rm <id>");

  const conn = await connectDaemon({ config });
  await conn.request<{ ok: true }>("DELETE", `/instances/${encodeURIComponent(id)}`);

  if (mode.json) {
    emitJson({ removed: true, id });
    return 0;
  }
  emitLine(`Removed instance "${id}".`);
  return 0;
}

async function cmdInstanceEdit(args: ParsedArgs, config: Config, mode: OutputMode): Promise<number> {
  const id = args.positionals[2];
  if (!id) throw new LlamactlError("bad_request", "usage: llamactl instance edit <id> [--name <name>] [flags]");
  const name = strOpt(args, "name");
  // The model selector stays the same unless re-specified as a positional.
  const model = args.positionals[3];

  const patch: { name?: string; spec?: LaunchSpec } = {};
  if (name !== undefined) patch.name = name;
  if (model !== undefined || hasSpecFlags(args)) {
    // Rebuild the spec; model defaults to the id if not re-given (the daemon
    // resolves it). Callers re-supplying flags replace the whole spec.
    patch.spec = flagsToSpec(model ?? id, args);
  }

  const conn = await connectDaemon({ config });
  const updated = await conn.request<InstanceConfig>("PUT", `/instances/${encodeURIComponent(id)}`, patch);

  if (mode.json) {
    emitJson(updated);
    return 0;
  }
  emitLine(`Updated instance "${updated.id}".`);
  return 0;
}

/** Whether any spec-shaping flag is present on the args. */
function hasSpecFlags(args: ParsedArgs): boolean {
  const keys = ["ctx", "ngl", "gpu-layers", "n-cpu-moe", "ncmoe", "threads", "batch-size",
    "flash-attn", "reasoning", "jinja", "cache-type-k", "cache-type-v", "chat-template",
    "host", "port", "extra-args"];
  return keys.some((k) => args.options[k] !== undefined);
}

/* -------------------------------- stop ----------------------------------- */

export async function cmdStop(args: ParsedArgs, _config: Config, mode: OutputMode): Promise<number> {
  const selector = args.positionals[1];
  if (!selector) throw new LlamactlError("bad_request", "usage: llamactl stop <model>");

  const rt = await readLiveRuntime();
  if (!rt) {
    if (mode.json) {
      emitJson({ stopped: false, reason: "daemon_not_running" });
      return 0;
    }
    emitLine("Daemon is not running; nothing to stop.");
    return 0;
  }
  const conn = clientFor(rt);
  const stopped = await conn.request<RunningModel>("POST", "/stop", { model: selector });

  if (mode.json) {
    emitJson(stopped);
    return 0;
  }
  emitLine(`Stopped ${stopped.name} (${stopped.modelId}).`);
  return 0;
}

/* --------------------------------- ps ------------------------------------ */

export async function cmdPs(_config: Config, mode: OutputMode): Promise<number> {
  const rt = await readLiveRuntime();
  let running: RunningModel[] = [];
  if (rt) {
    const conn = clientFor(rt);
    const res = await conn.request<PsResponse>("GET", "/ps");
    running = res.running;
  }

  if (mode.json) {
    emitJson({ running });
    return 0;
  }

  if (running.length === 0) {
    emitLine(rt ? "No models running." : "Daemon is not running.");
    return 0;
  }

  const now = Date.now();
  const columns: Column<RunningModel>[] = [
    { header: "MODEL", get: (r) => r.modelId },
    { header: "PORT", get: (r) => String(r.port), alignRight: true },
    { header: "PID", get: (r) => String(r.pid), alignRight: true },
    { header: "STATUS", get: (r) => r.status },
    { header: "UPTIME", get: (r) => humanUptime(r.startedAt, now), alignRight: true },
    { header: "RESTARTS", get: (r) => String(r.restarts), alignRight: true },
  ];
  emitLine(renderTable(running, columns, mode));
  return 0;
}

/* ----------------------------- daemon start/stop ------------------------- */

export async function cmdDaemonStart(config: Config, mode: OutputMode): Promise<number> {
  const existing = await readLiveRuntime();
  if (existing) {
    if (mode.json) {
      emitJson({ status: "already_running", controlUrl: existing.controlUrl });
      return 0;
    }
    emitLine(`Daemon already running (pid ${existing.pid}).`);
    return 0;
  }

  // connectDaemon spawns the detached daemon and waits for runtime.json.
  const conn = await connectDaemon({ config });
  if (mode.json) {
    emitJson({
      status: "started",
      pid: conn.runtime.pid,
      controlUrl: conn.runtime.controlUrl,
    });
    return 0;
  }
  emitLine(`Daemon started (pid ${conn.runtime.pid}).`);
  emitLine(`Control plane: ${conn.runtime.controlUrl} (loopback, token-guarded)`);
  return 0;
}

export async function cmdDaemonStop(mode: OutputMode): Promise<number> {
  const rt = await currentRuntime();
  if (!rt) {
    if (mode.json) {
      emitJson({ stopped: false, reason: "not_running" });
      return 0;
    }
    emitLine("Daemon is not running.");
    return 0;
  }

  // Ask the daemon to shut down via SIGTERM, then wait for it to clear runtime.json.
  try {
    process.kill(rt.pid, "SIGTERM");
  } catch {
    // Already gone; fall through to cleanup.
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(rt.pid)) break;
    await sleep(100);
  }
  // Best-effort: if the process is gone but the file lingers, clear it.
  if (!isProcessAlive(rt.pid)) await clearRuntime();

  if (mode.json) {
    emitJson({ stopped: true, pid: rt.pid });
    return 0;
  }
  emitLine(`Daemon stopped (pid ${rt.pid}).`);
  return 0;
}

/* -------------------------------- rm model ------------------------------- */

export async function cmdRm(args: ParsedArgs, config: Config, mode: OutputMode): Promise<number> {
  const selector = args.positionals[1];
  if (!selector) throw new LlamactlError("bad_request", "usage: llamactl rm <model> --yes");

  // Resolve locally so we can show what will be deleted and confirm by id.
  const models = await discoverModels({ extraPaths: modelScanPaths(config) });
  const model = resolveModel(models, selector); // throws model_not_found / ambiguous_model

  if (!boolOpt(args, "yes")) {
    if (mode.json) {
      emitJson({ wouldDelete: model.id, path: model.path, hint: "pass --yes to confirm" });
      return 0;
    }
    emitLine(`This will delete ${model.id} (${model.path}) from disk.`);
    emitLine("Re-run with --yes to confirm.");
    return 0;
  }

  const conn = await connectDaemon({ config });
  const res = await conn.request<{ ok: true; removed: string[] }>(
    "DELETE",
    `/models/${encodeURIComponent(model.id)}`,
  );
  if (mode.json) {
    emitJson(res);
    return 0;
  }
  emitLine(`Deleted ${model.id} (${res.removed.length} file(s)).`);
  return 0;
}

/* ------------------------------ hugging face ----------------------------- */

export async function cmdSearch(args: ParsedArgs, config: Config, mode: OutputMode): Promise<number> {
  const query = args.positionals.slice(1).join(" ").trim();
  if (!query) throw new LlamactlError("bad_request", "usage: llamactl search <query>");

  const conn = await connectDaemon({ config });
  const { repos } = await conn.request<HfSearchResponse>(
    "GET",
    `/hf/search?q=${encodeURIComponent(query)}`,
  );

  if (mode.json) {
    emitJson({ repos });
    return 0;
  }
  if (repos.length === 0) {
    emitLine(`No GGUF repos found for "${query}".`);
    return 0;
  }
  const columns: Column<HfRepo>[] = [
    { header: "REPO", get: (r) => r.id },
    { header: "DOWNLOADS", get: (r) => String(r.downloads), alignRight: true },
    { header: "LIKES", get: (r) => String(r.likes), alignRight: true },
    { header: "GATED", get: (r) => (r.gated ? "yes" : "—") },
  ];
  emitLine(renderTable(repos, columns, mode));
  emitLine("");
  emitLine("Pull one with: llamactl pull <repo>:<quant>   (e.g. :Q4_K_M)");
  return 0;
}

/** Resolve which file in a repo to pull from an optional quant / explicit file. */
async function resolvePullFile(
  conn: Awaited<ReturnType<typeof connectDaemon>>,
  repo: string,
  quant: string | undefined,
  explicitFile: string | undefined,
): Promise<string> {
  if (explicitFile) return explicitFile;
  const { files } = await conn.request<HfFilesResponse>(
    "GET",
    `/hf/files?repo=${encodeURIComponent(repo)}`,
  );
  if (files.length === 0) {
    throw new LlamactlError("not_found", `no GGUF files found in ${repo}`);
  }
  const bySize = (a: HfFile, b: HfFile): number => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0);
  if (quant) {
    const matches = files.filter((f) => f.quant?.toLowerCase() === quant.toLowerCase());
    if (matches.length === 0) {
      const avail = [...new Set(files.map((f) => f.quant).filter(Boolean))].join(", ");
      throw new LlamactlError("not_found", `no "${quant}" quant in ${repo}. Available: ${avail || "—"}`);
    }
    return matches.sort(bySize)[0]!.rfilename;
  }
  if (files.length === 1) return files[0]!.rfilename;
  const list = files.map((f) => `  ${f.quant ?? "?"}\t${f.rfilename}`).join("\n");
  throw new LlamactlError(
    "bad_request",
    `${repo} has multiple files; pick a quant (repo:QUANT) or --file:\n${list}`,
  );
}

export async function cmdPull(args: ParsedArgs, config: Config, mode: OutputMode): Promise<number> {
  const target = args.positionals[1];
  if (!target) throw new LlamactlError("bad_request", "usage: llamactl pull <repo>[:quant] [--file <f>]");
  // Split a trailing :quant off the "org/name" repo (repos never contain a colon).
  const colon = target.indexOf(":");
  const repo = colon === -1 ? target : target.slice(0, colon);
  const quant = colon === -1 ? undefined : target.slice(colon + 1);

  const conn = await connectDaemon({ config });
  const file = await resolvePullFile(conn, repo, quant, strOpt(args, "file"));
  const { downloads } = await conn.request<DownloadsResponse>("POST", "/pull", {
    repo,
    file,
    revision: strOpt(args, "revision"),
  });

  if (mode.json) {
    emitJson({ downloads });
    return 0;
  }
  for (const d of downloads) emitLine(`Downloading ${d.repo} / ${d.file} → ${d.destPath}`);
  emitLine("Track progress with: llamactl downloads");
  return 0;
}

export async function cmdDownloads(args: ParsedArgs, config: Config, mode: OutputMode): Promise<number> {
  const sub = args.positionals[1];
  const conn = await connectDaemon({ config });

  if (sub === "cancel") {
    const id = args.positionals[2];
    if (!id) throw new LlamactlError("bad_request", "usage: llamactl downloads cancel <id>");
    await conn.request<{ ok: true }>("POST", `/downloads/${encodeURIComponent(id)}/cancel`);
    if (mode.json) emitJson({ canceled: true, id });
    else emitLine(`Canceled ${id}.`);
    return 0;
  }

  const { downloads } = await conn.request<DownloadsResponse>("GET", "/downloads");
  if (mode.json) {
    emitJson({ downloads });
    return 0;
  }
  if (downloads.length === 0) {
    emitLine("No downloads.");
    return 0;
  }
  const pctOf = (d: Download): string =>
    d.totalBytes ? `${Math.floor((100 * d.receivedBytes) / d.totalBytes)}%` : "—";
  const columns: Column<Download>[] = [
    { header: "ID", get: (d) => d.id },
    { header: "STATUS", get: (d) => d.status },
    { header: "PROGRESS", get: pctOf, alignRight: true },
    {
      header: "SIZE",
      get: (d) => `${humanBytes(d.receivedBytes)}${d.totalBytes ? ` / ${humanBytes(d.totalBytes)}` : ""}`,
      alignRight: true,
    },
  ];
  emitLine(renderTable(downloads, columns, mode));
  return 0;
}

/* ------------------------------- installs -------------------------------- */

/** Build statuses that are still in flight (worth surfacing under the table). */
const NON_TERMINAL_BUILDS = new Set(["queued", "cloning", "configuring", "building", "installing"]);

export async function cmdInstall(args: ParsedArgs, config: Config, mode: OutputMode): Promise<number> {
  const sub = args.positionals[1];
  switch (sub) {
    case undefined:
    case "ls":
    case "list":
      return cmdInstallList(config, mode);
    case "use":
      return cmdInstallUse(args, config, mode);
    case "rm":
    case "remove":
      return cmdInstallRemove(args, config, mode);
    case "cancel":
      return cmdInstallCancel(args, config, mode);
    case "log":
    case "logs":
      return cmdInstallLog(args, config, mode);
    case "build":
      // Explicit build; repo is the next positional (omitted ⇒ upstream default).
      return cmdInstallBuild(args.positionals[2], args, config, mode);
    default:
      // Anything else is treated as a repo to build.
      return cmdInstallBuild(sub, args, config, mode);
  }
}

async function cmdInstallList(config: Config, mode: OutputMode): Promise<number> {
  const conn = await connectDaemon({ config });
  const res = await conn.request<InstallsResponse>("GET", "/installs");

  if (mode.json) {
    emitJson(res);
    return 0;
  }
  if (res.installs.length === 0 && res.builds.length === 0) {
    emitLine("No managed llama.cpp installs. Build one with 'llamactl install <repo>'.");
    return 0;
  }
  if (res.installs.length > 0) {
    const columns: Column<LlamaInstall>[] = [
      { header: "ID", get: (i) => i.id },
      { header: "NAME", get: (i) => i.name },
      { header: "REF", get: (i) => i.ref },
      { header: "BACKEND", get: (i) => i.backend },
      { header: "VERSION", get: (i) => i.version ?? "-" },
      { header: "ACTIVE", get: (i) => (i.id === res.activeId ? "*" : "") },
    ];
    emitLine(renderTable(res.installs, columns, mode));
  }
  const active = res.builds.filter((b) => NON_TERMINAL_BUILDS.has(b.status));
  if (active.length > 0) {
    emitLine("");
    emitLine("Builds in progress:");
    for (const b of active) {
      const last = b.logTail[b.logTail.length - 1];
      emitLine(`  ${b.id}  ${b.status}${last ? `  ${last}` : ""}`);
    }
  }
  const failed = res.builds.filter((b) => b.status === "error");
  if (failed.length > 0) {
    emitLine("");
    emitLine("Failed builds:");
    for (const b of failed) {
      emitLine(`  ${b.id}  ${b.error ?? "(unknown error)"}`);
    }
    emitLine("View a log with 'llamactl install log <id>'; clear it with 'llamactl install rm <id>'.");
  }
  return 0;
}

async function cmdInstallLog(args: ParsedArgs, config: Config, mode: OutputMode): Promise<number> {
  const id = args.positionals[2];
  if (!id) throw new LlamactlError("bad_request", "usage: llamactl install log <id>");

  const conn = await connectDaemon({ config });
  const res = await conn.request<InstallsResponse>("GET", "/installs");
  const build = res.builds.find((b) => b.id === id);
  if (!build) {
    throw new LlamactlError("install_not_found", `no build with id "${id}"`, { detail: { id } });
  }

  // The log file lives on the same host as the daemon (loopback), so read it
  // directly; fall back to the in-memory logTail if the file is gone.
  let text = "";
  try {
    const file = Bun.file(build.logPath);
    if (await file.exists()) text = await file.text();
  } catch {
    text = "";
  }
  if (text === "") text = build.logTail.join("\n");

  if (mode.json) {
    emitJson({ id, status: build.status, error: build.error, logPath: build.logPath, log: text });
    return 0;
  }
  if (text !== "") emitLine(text.replace(/\n$/, ""));
  if (build.error) emitLine(`\nError: ${build.error}`);
  return 0;
}

async function cmdInstallUse(args: ParsedArgs, config: Config, mode: OutputMode): Promise<number> {
  const id = args.positionals[2];
  if (!id) throw new LlamactlError("bad_request", "usage: llamactl install use <id>");

  const conn = await connectDaemon({ config });
  const res = await conn.request<InstallsResponse>("PUT", "/installs/active", { id });

  if (mode.json) {
    emitJson(res);
    return 0;
  }
  emitLine(`Active install set to "${id}".`);
  return 0;
}

async function cmdInstallRemove(args: ParsedArgs, config: Config, mode: OutputMode): Promise<number> {
  const id = args.positionals[2];
  if (!id) throw new LlamactlError("bad_request", "usage: llamactl install rm <id>");

  const conn = await connectDaemon({ config });
  const res = await conn.request<InstallsResponse>("DELETE", `/installs/${encodeURIComponent(id)}`);

  if (mode.json) {
    emitJson(res);
    return 0;
  }
  emitLine(`Removed install "${id}".`);
  return 0;
}

async function cmdInstallCancel(args: ParsedArgs, config: Config, mode: OutputMode): Promise<number> {
  const id = args.positionals[2];
  if (!id) throw new LlamactlError("bad_request", "usage: llamactl install cancel <id>");

  const conn = await connectDaemon({ config });
  const res = await conn.request<InstallsResponse>(
    "POST",
    `/installs/${encodeURIComponent(id)}/cancel`,
  );

  if (mode.json) {
    emitJson(res);
    return 0;
  }
  emitLine(`Canceled build "${id}".`);
  return 0;
}

async function cmdInstallBuild(
  repoArg: string | undefined,
  args: ParsedArgs,
  config: Config,
  mode: OutputMode,
): Promise<number> {
  const backend = strOpt(args, "backend");
  if (backend !== undefined && backend !== "cpu" && backend !== "cuda") {
    throw new LlamactlError("bad_request", `--backend must be "cpu" or "cuda"`);
  }

  // An empty/omitted repo defaults to upstream llama.cpp (filled in by the daemon).
  const body: BuildRequest = { repo: repoArg?.trim() ?? "" };
  const ref = strOpt(args, "ref");
  if (ref !== undefined) body.ref = ref;
  if (backend !== undefined) body.backend = backend as LlamaBackend;
  const name = strOpt(args, "name");
  if (name !== undefined) body.name = name;
  if (boolOpt(args, "keep-source")) body.keepSource = true;
  if (boolOpt(args, "allow-unsupported-compiler")) body.allowUnsupportedCompiler = true;
  const cudaHost = strOpt(args, "cuda-host-compiler");
  if (cudaHost !== undefined) body.cudaHostCompiler = cudaHost;

  const conn = await connectDaemon({ config });
  const res = await conn.request<InstallsResponse>("POST", "/installs", body);

  if (mode.json) {
    emitJson(res);
    return 0;
  }
  // The freshly queued job is the most recently started build for this repo.
  const job = [...res.builds].sort((a, b) => b.startedAt - a.startedAt)[0];
  if (job) emitLine(`Build started: ${job.id} (${job.status})`);
  else emitLine("Build started.");
  emitLine("Track progress with: llamactl install list");
  return 0;
}

/* ----------------------------- stubs (Phase 8) --------------------------- */

function stub(name: string, mode: OutputMode, note: string): number {
  if (mode.json) {
    emitJson({ command: name, status: "not_implemented", note });
    return 0;
  }
  emitLine(`'${name}' is not implemented yet — ${note}`);
  return 0;
}

export function cmdInit(mode: OutputMode): number {
  return stub("init", mode, "interactive setup wizard arrives in a later phase.");
}
export function cmdRecommend(mode: OutputMode): number {
  return stub("recommend", mode, "model recommendations arrive in a later phase.");
}
export function cmdDoctor(mode: OutputMode): number {
  return stub("doctor", mode, "environment diagnostics arrive in a later phase.");
}

/* ------------------------------- error sink ------------------------------ */

/** Render a caught error per the output mode and return a process exit code. */
export function reportError(e: unknown, mode: OutputMode): number {
  const err = isLlamactlError(e)
    ? e
    : new LlamactlError("internal", e instanceof Error ? e.message : String(e));
  if (mode.json) {
    emitJson(err.toApiError());
  } else {
    emitError(`error[${err.code}]: ${err.message}`);
  }
  return 1;
}
