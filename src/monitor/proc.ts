/**
 * Pure `/proc` readers for the resource monitor. These functions do exactly one
 * thing: read a `/proc` file and turn it into a small raw struct. They hold NO
 * cross-sample state — all delta math lives in `sampler.ts`. Linux-only; every
 * reader degrades gracefully (returns null/0) where `/proc` is missing or a pid
 * has gone away. Parsing is split into exported pure helpers so the logic is
 * unit-testable without touching the real `/proc`.
 */

import os from "node:os";
import { readdir } from "node:fs/promises";

/**
 * USER_HZ — the number of scheduler ticks per second that `/proc` jiffy fields
 * are denominated in. The kernel does not expose this to userspace cheaply, but
 * on virtually every Linux build (including Fedora) it is 100. We assume 100;
 * if a host used a different CONFIG_HZ, per-process CPU% would be scaled by a
 * constant factor but still track relative load correctly.
 */
export const CLOCK_TICK = 100;

/** Raw system CPU counters, in jiffies, parsed from the `cpu ` line. */
export interface SystemCpuRaw {
  /** Sum of all numeric fields on the `cpu ` line. */
  total: number;
  /** idle + iowait (fields 4 and 5). */
  idle: number;
}

/** Raw per-process CPU counter: utime + stime, in jiffies. */
export interface PidCpuRaw {
  jiffies: number;
}

/** Number of logical CPUs, at least 1. */
export function cpuCount(): number {
  const n = os.cpus().length;
  return n > 0 ? n : 1;
}

/**
 * Parse the first `cpu ` aggregate line of `/proc/stat`. Returns null if no such
 * line is present or it has fewer than the 5 fields we need.
 */
export function parseSystemCpu(text: string): SystemCpuRaw | null {
  for (const line of text.split("\n")) {
    if (!line.startsWith("cpu ")) continue;
    // Fields after the "cpu" label: user nice system idle iowait irq softirq ...
    const parts = line.trim().split(/\s+/).slice(1);
    const nums = parts.map((p) => Number(p));
    if (nums.length < 5 || nums.some((n) => !Number.isFinite(n))) return null;
    let total = 0;
    for (const n of nums) total += n;
    const idle = (nums[3] ?? 0) + (nums[4] ?? 0); // idle + iowait
    return { total, idle };
  }
  return null;
}

/**
 * Parse `/proc/meminfo`. `memTotal` from MemTotal, available from MemAvailable;
 * `memUsed = memTotal - memAvailable`. Source values are in kB and converted to
 * bytes. Returns null if either field is missing.
 */
export function parseMemInfo(text: string): { memUsed: number; memTotal: number } | null {
  let memTotalKb: number | null = null;
  let memAvailKb: number | null = null;
  for (const line of text.split("\n")) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (!m) continue;
    const key = m[1];
    const val = Number(m[2]);
    if (!Number.isFinite(val)) continue;
    if (key === "MemTotal") memTotalKb = val;
    else if (key === "MemAvailable") memAvailKb = val;
  }
  if (memTotalKb === null || memAvailKb === null) return null;
  const memTotal = memTotalKb * 1024;
  const memUsed = (memTotalKb - memAvailKb) * 1024;
  return { memUsed, memTotal };
}

/**
 * Parse a `/proc/<pid>/stat` line into utime+stime jiffies. The 2nd field
 * (comm) is wrapped in parens and may itself contain spaces and parens, so we
 * take the substring AFTER the last ")" and index into the remaining
 * whitespace-separated fields. In that tail, utime is index 11 and stime is
 * index 12 (overall 1-based fields 14 and 15). Returns null on malformed input.
 */
export function parsePidStat(text: string): PidCpuRaw | null {
  const close = text.lastIndexOf(")");
  if (close === -1) return null;
  const tail = text.slice(close + 1).trim();
  if (tail.length === 0) return null;
  const fields = tail.split(/\s+/);
  // tail[0] is field 3 (state). utime is field 14 => tail index 11.
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { jiffies: utime + stime };
}

/**
 * Parse `VmRSS` (kB) from `/proc/<pid>/status` and return it in bytes; 0 if the
 * field is absent or unparseable.
 */
export function parseVmRss(text: string): number {
  const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(text);
  if (!m) return 0;
  const kb = Number(m[1]);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

/** Read+parse the `cpu ` line of `/proc/stat`; null if unreadable. */
export async function readSystemCpuRaw(): Promise<SystemCpuRaw | null> {
  try {
    const text = await Bun.file("/proc/stat").text();
    return parseSystemCpu(text);
  } catch {
    return null;
  }
}

/** Read+parse `/proc/meminfo`; null if unreadable. */
export async function readMemInfo(): Promise<{ memUsed: number; memTotal: number } | null> {
  try {
    const text = await Bun.file("/proc/meminfo").text();
    return parseMemInfo(text);
  } catch {
    return null;
  }
}

/** Read+parse `/proc/<pid>/stat`; null if the pid is gone or unreadable. */
export async function readPidCpuRaw(pid: number): Promise<PidCpuRaw | null> {
  try {
    const text = await Bun.file(`/proc/${pid}/stat`).text();
    return parsePidStat(text);
  } catch {
    return null;
  }
}

/** Read `VmRSS` from `/proc/<pid>/status` in bytes; 0 if unreadable. */
export async function readPidRss(pid: number): Promise<number> {
  try {
    const text = await Bun.file(`/proc/${pid}/status`).text();
    return parseVmRss(text);
  } catch {
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* CPU temperature (best-effort, Linux sysfs).                                 */
/* -------------------------------------------------------------------------- */

/** hwmon device names that are dedicated CPU temperature drivers (best signal). */
const CPU_HWMON_NAMES = ["coretemp", "k10temp", "zenpower"];
/**
 * hwmon temp `*_label` patterns that denote a CPU sensor, in priority order.
 * Anchored so motherboard labels like "PCH_CPU_TEMP" don't match. Covers Intel
 * (Package id N / Core N), AMD direct (Tctl / Tccd) and AMD via Super-I/O
 * (TSI0_TEMP / CPUTIN / PECI).
 */
const CPU_LABEL_MATCHERS: RegExp[] = [
  /^tctl$/,
  /^tccd\d*$/,
  /^package id \d+$/,
  /^core \d+$/,
  /^cpu$/,
  /^tsi0_temp$/,
  /^cputin$/,
  /^peci agent 0/,
];
/** sysfs thermal-zone `type` substrings that denote a CPU package sensor. */
const CPU_ZONE_PRIORITY = ["x86_pkg_temp", "coretemp", "k10temp", "zenpower"];

/** Resolved sysfs temp file: undefined = not probed, null = none available. */
let cpuTempPath: string | null | undefined;

/**
 * Find a sysfs file holding the CPU temperature in millidegrees, or null.
 * Ranks candidates: dedicated CPU hwmon drivers first, then CPU-labelled hwmon
 * sensors, then CPU thermal zones — so a wifi/PCH sensor never wins.
 */
async function resolveCpuTempPath(): Promise<string | null> {
  let best: { rank: number; path: string } | null = null;
  const consider = (rank: number, path: string): void => {
    if (best === null || rank < best.rank) best = { rank, path };
  };

  // hwmon: by driver name (rank 0+) and by per-sensor label (rank 100+).
  try {
    const base = "/sys/class/hwmon";
    for (const h of await readdir(base)) {
      const dir = `${base}/${h}`;
      let name = "";
      try {
        name = (await Bun.file(`${dir}/name`).text()).trim().toLowerCase();
      } catch {
        /* no name file */
      }
      const nameRank = CPU_HWMON_NAMES.indexOf(name);
      if (nameRank !== -1) consider(nameRank, `${dir}/temp1_input`);

      let entries: string[] = [];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const f of entries) {
        const m = /^temp(\d+)_label$/.exec(f);
        if (!m) continue;
        let label = "";
        try {
          label = (await Bun.file(`${dir}/${f}`).text()).trim().toLowerCase();
        } catch {
          continue;
        }
        const lr = CPU_LABEL_MATCHERS.findIndex((re) => re.test(label));
        if (lr !== -1) consider(100 + lr, `${dir}/temp${m[1]}_input`);
      }
    }
  } catch {
    /* fall through to thermal zones */
  }

  // thermal zones (rank 200+): last resort, CPU-package types only.
  try {
    const base = "/sys/class/thermal";
    const zones = (await readdir(base)).filter((e) => e.startsWith("thermal_zone"));
    for (const z of zones) {
      let type = "";
      try {
        type = (await Bun.file(`${base}/${z}/type`).text()).trim().toLowerCase();
      } catch {
        continue;
      }
      const r = CPU_ZONE_PRIORITY.findIndex((p) => type.includes(p));
      if (r !== -1) consider(200 + r, `${base}/${z}/temp`);
    }
  } catch {
    /* ignore */
  }

  return best ? best.path : null;
}

/**
 * Read the CPU package temperature in °C, or null if no sensor is found. The
 * sensor path is resolved once and cached, so steady-state reads are a single
 * file read.
 */
export async function readCpuTempC(): Promise<number | null> {
  if (cpuTempPath === undefined) cpuTempPath = await resolveCpuTempPath();
  if (cpuTempPath === null) return null;
  try {
    const milli = Number((await Bun.file(cpuTempPath).text()).trim());
    return Number.isFinite(milli) ? Math.round(milli / 1000) : null;
  } catch {
    return null;
  }
}
