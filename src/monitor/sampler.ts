/**
 * The Sampler owns ALL cross-sample delta state for the resource monitor. On an
 * interval it reads the stateless `/proc` and `nvidia-smi` raw values, diffs
 * them against the previous tick to derive CPU percentages, joins per-pid VRAM,
 * and caches a `StatsSnapshot`. `snapshot()` is a cheap accessor returning the
 * last computed value — it never does I/O and never throws. Every tick is
 * guarded so a transient read error cannot kill the interval. The CPU delta math
 * is factored into exported pure helpers (`systemCpuPct`, `pidCpuPct`) for
 * unit testing without timers or hardware.
 */

import type {
  ISupervisor,
  StatsSnapshot,
  GpuStats,
  InstanceStats,
} from "../types.ts";
import {
  CLOCK_TICK,
  readSystemCpuRaw,
  readMemInfo,
  readPidCpuRaw,
  readPidRss,
  readCpuTempC,
  type SystemCpuRaw,
} from "./proc.ts";
import { nvidiaAvailable, queryGpus, queryProcessVram } from "./nvidia.ts";

export interface SamplerOptions {
  supervisor: ISupervisor;
  /** Sampling interval in ms. Default 1000. */
  intervalMs?: number;
}

/**
 * Compute system-wide CPU utilization (0..100) from two raw samples. Returns 0
 * on the first sample (no prev) or when the total delta is non-positive.
 */
export function systemCpuPct(prev: SystemCpuRaw | null, cur: SystemCpuRaw): number {
  if (!prev) return 0;
  const dTotal = cur.total - prev.total;
  const dIdle = cur.idle - prev.idle;
  if (dTotal <= 0) return 0;
  const pct = (100 * (dTotal - dIdle)) / dTotal;
  return pct < 0 ? 0 : pct;
}

/**
 * Compute a process's CPU use as percent of one core. `dWallSeconds` is the wall
 * time elapsed since the previous sample. Returns 0 if either delta is
 * non-positive (e.g. first sighting of the pid). Can exceed 100 on a thread that
 * uses more than one core.
 */
export function pidCpuPct(
  prevJiffies: number,
  curJiffies: number,
  dWallSeconds: number,
): number {
  const dJiffies = curJiffies - prevJiffies;
  if (dJiffies <= 0 || dWallSeconds <= 0) return 0;
  const pct = (100 * dJiffies) / (dWallSeconds * CLOCK_TICK);
  return pct < 0 ? 0 : pct;
}

/** Build the zeroed snapshot returned before the first tick completes. */
function emptySnapshot(): StatsSnapshot {
  return {
    ts: Date.now(),
    system: { cpuPct: 0, memUsed: 0, memTotal: 0, tempC: null },
    gpus: [],
    instances: [],
    gpuAvailable: nvidiaAvailable(),
  };
}

export class Sampler {
  private readonly supervisor: ISupervisor;
  private readonly intervalMs: number;

  private prevSystem: SystemCpuRaw | null = null;
  private prevPids = new Map<number, { jiffies: number; ts: number }>();

  private timer: ReturnType<typeof setInterval> | null = null;
  private last: StatsSnapshot;

  constructor(opts: SamplerOptions) {
    this.supervisor = opts.supervisor;
    this.intervalMs = opts.intervalMs ?? 1000;
    this.last = emptySnapshot();
  }

  /** Begin the sampling loop; samples immediately, then every `intervalMs`. */
  start(): void {
    if (this.timer !== null) return;
    void this.sampleOnce();
    this.timer = setInterval(() => {
      void this.sampleOnce();
    }, this.intervalMs);
  }

  /** Stop the sampling loop. Safe to call when not running. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Return the last computed snapshot. Cheap; no I/O. */
  snapshot(): StatsSnapshot {
    return this.last;
  }

  /** One sampling tick: read raw values, diff, join, and cache a snapshot. */
  private async sampleOnce(): Promise<void> {
    try {
      const now = Date.now();
      const children = this.supervisor.list();

      // System CPU + memory.
      const curSystem = await readSystemCpuRaw();
      const mem = await readMemInfo();
      const cpuTempC = await readCpuTempC();
      const cpuPct = curSystem ? systemCpuPct(this.prevSystem, curSystem) : 0;
      if (curSystem) this.prevSystem = curSystem;

      // GPU stats (only if nvidia-smi is present), in parallel.
      const gpuOn = nvidiaAvailable();
      const [gpuRaws, procVram] = gpuOn
        ? await Promise.all([queryGpus(), queryProcessVram()])
        : [[], new Map<number, number>()];

      const gpus: GpuStats[] = gpuRaws.map((g) => ({
        index: g.index,
        name: g.name,
        utilPct: g.utilPct,
        vramUsed: g.vramUsed,
        vramTotal: g.vramTotal,
        tempC: g.tempC,
      }));

      // Per-instance CPU/RSS/VRAM.
      const instances: InstanceStats[] = [];
      const seen = new Set<number>();
      for (const child of children) {
        const { modelId, pid } = child;
        seen.add(pid);
        const cpuRaw = await readPidCpuRaw(pid);
        const rssBytes = await readPidRss(pid);
        let pidCpu = 0;
        if (cpuRaw) {
          const prev = this.prevPids.get(pid);
          if (prev) {
            const dWallSeconds = (now - prev.ts) / 1000;
            pidCpu = pidCpuPct(prev.jiffies, cpuRaw.jiffies, dWallSeconds);
          }
          this.prevPids.set(pid, { jiffies: cpuRaw.jiffies, ts: now });
        }
        instances.push({
          modelId,
          pid,
          cpuPct: pidCpu,
          rssBytes,
          vramBytes: procVram.get(pid) ?? 0,
        });
      }

      // Forget pids that are no longer tracked / running.
      for (const pid of this.prevPids.keys()) {
        if (!seen.has(pid)) this.prevPids.delete(pid);
      }

      this.last = {
        ts: now,
        system: {
          cpuPct,
          memUsed: mem?.memUsed ?? 0,
          memTotal: mem?.memTotal ?? 0,
          tempC: cpuTempC,
        },
        gpus,
        instances,
        gpuAvailable: gpuOn,
      };
    } catch {
      // A transient read error must never kill the interval; keep the last
      // good snapshot in place until the next tick.
    }
  }
}
