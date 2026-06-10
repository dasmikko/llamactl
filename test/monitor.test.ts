import { describe, test, expect } from "bun:test";

import {
  parseSystemCpu,
  parseMemInfo,
  parsePidStat,
  parseVmRss,
  cpuCount,
  CLOCK_TICK,
} from "../src/monitor/proc.ts";
import { parseGpuCsv, parseProcVramCsv } from "../src/monitor/nvidia.ts";
import { systemCpuPct, pidCpuPct, Sampler } from "../src/monitor/sampler.ts";
import type { ISupervisor, RunningModel } from "../src/types.ts";

const MIB = 1024 * 1024;

describe("parseSystemCpu", () => {
  test("sums all fields and uses idle+iowait", () => {
    // user nice system idle iowait irq softirq steal
    const text = "cpu  10 20 30 40 5 1 2 0\ncpu0 5 10 15 20 2 0 1 0\n";
    const raw = parseSystemCpu(text);
    expect(raw).not.toBeNull();
    expect(raw!.total).toBe(10 + 20 + 30 + 40 + 5 + 1 + 2 + 0);
    expect(raw!.idle).toBe(40 + 5);
  });

  test("returns null without a cpu line", () => {
    expect(parseSystemCpu("intr 12345\nctxt 678\n")).toBeNull();
  });

  test("returns null with too few fields", () => {
    expect(parseSystemCpu("cpu  1 2 3\n")).toBeNull();
  });
});

describe("parseMemInfo", () => {
  test("computes used = total - available, converts kB to bytes", () => {
    const text = [
      "MemTotal:       16000000 kB",
      "MemFree:         2000000 kB",
      "MemAvailable:    8000000 kB",
      "Buffers:          100000 kB",
    ].join("\n");
    const m = parseMemInfo(text);
    expect(m).not.toBeNull();
    expect(m!.memTotal).toBe(16000000 * 1024);
    expect(m!.memUsed).toBe((16000000 - 8000000) * 1024);
  });

  test("returns null when MemAvailable is missing", () => {
    expect(parseMemInfo("MemTotal: 16000000 kB\n")).toBeNull();
  });
});

describe("parsePidStat", () => {
  test("parses utime+stime for a plain comm", () => {
    // pid (comm) state ppid ... fields 14,15 are utime,stime.
    const fields = [
      "1234", // 1 pid
      "(bash)", // 2 comm
      "S", // 3 state
      "1", // 4 ppid
      "1234", // 5 pgrp
      "1234", // 6 session
      "0", // 7 tty_nr
      "-1", // 8 tpgid
      "0", // 9 flags
      "100", // 10 minflt
      "0", // 11 cminflt
      "200", // 12 majflt
      "0", // 13 cmajflt
      "150", // 14 utime
      "75", // 15 stime
      "5", // 16 cutime
      "2", // 17 cstime
    ];
    const raw = parsePidStat(fields.join(" "));
    expect(raw).not.toBeNull();
    expect(raw!.jiffies).toBe(150 + 75);
  });

  test("handles comm containing spaces and parens", () => {
    // comm = "(my )( weird) proc)" — embedded spaces and parens. Real-world
    // example: "(llama server)" or "(Web Content)". Use last ')' to split.
    const comm = "(weird ) (proc) name)";
    const rest = [
      "R", // state
      "1", // ppid
      "1", // pgrp
      "1", // session
      "0", // tty
      "-1", // tpgid
      "0", // flags
      "0", // minflt
      "0", // cminflt
      "0", // majflt
      "0", // cmajflt
      "300", // utime (field 14)
      "120", // stime (field 15)
      "0",
      "0",
    ];
    const line = `999 ${comm} ${rest.join(" ")}`;
    const raw = parsePidStat(line);
    expect(raw).not.toBeNull();
    expect(raw!.jiffies).toBe(300 + 120);
  });

  test("returns null without a closing paren", () => {
    expect(parsePidStat("1234 bash S 1 ...")).toBeNull();
  });
});

describe("parseVmRss", () => {
  test("converts kB to bytes", () => {
    const text = ["Name:\tllama-server", "VmRSS:\t  123456 kB", "Threads:\t8"].join("\n");
    expect(parseVmRss(text)).toBe(123456 * 1024);
  });

  test("returns 0 when VmRSS is absent", () => {
    expect(parseVmRss("Name:\tx\nThreads:\t1\n")).toBe(0);
  });
});

describe("cpuCount / CLOCK_TICK", () => {
  test("cpuCount is at least 1", () => {
    expect(cpuCount()).toBeGreaterThanOrEqual(1);
  });
  test("CLOCK_TICK is 100", () => {
    expect(CLOCK_TICK).toBe(100);
  });
});

describe("parseGpuCsv", () => {
  test("parses rows and converts MiB to bytes", () => {
    const text = "0, NVIDIA GeForce RTX 4090, 37, 1024, 24564, 55\n1, NVIDIA A100, 0, 0, 40960\n";
    const gpus = parseGpuCsv(text);
    expect(gpus).toHaveLength(2);
    expect(gpus[0]).toEqual({
      index: 0,
      name: "NVIDIA GeForce RTX 4090",
      utilPct: 37,
      vramUsed: 1024 * MIB,
      vramTotal: 24564 * MIB,
      tempC: 55,
    });
    // Temperature column absent ⇒ tempC null.
    expect(gpus[1]!.name).toBe("NVIDIA A100");
    expect(gpus[1]!.vramTotal).toBe(40960 * MIB);
    expect(gpus[1]!.tempC).toBeNull();
  });

  test("skips blank lines and unparseable rows", () => {
    const text = "\n0, GPU, [N/A], 100, 200\n1, GPU, 50, 100, 200\n";
    const gpus = parseGpuCsv(text);
    expect(gpus).toHaveLength(1);
    expect(gpus[0]!.index).toBe(1);
  });
});

describe("parseProcVramCsv", () => {
  test("maps pid to bytes, converting MiB", () => {
    const text = "4242, 512\n4243, 2048\n";
    const m = parseProcVramCsv(text);
    expect(m.get(4242)).toBe(512 * MIB);
    expect(m.get(4243)).toBe(2048 * MIB);
  });

  test("skips rows where memory is [N/A] or '-'", () => {
    const text = "100, [N/A]\n101, -\n102, 256\n";
    const m = parseProcVramCsv(text);
    expect(m.has(100)).toBe(false);
    expect(m.has(101)).toBe(false);
    expect(m.get(102)).toBe(256 * MIB);
  });
});

describe("systemCpuPct", () => {
  test("returns 0 on the first sample (no prev)", () => {
    expect(systemCpuPct(null, { total: 1000, idle: 800 })).toBe(0);
  });

  test("computes busy fraction from deltas", () => {
    // total +100, idle +75 => busy 25 => 25%.
    const pct = systemCpuPct({ total: 1000, idle: 800 }, { total: 1100, idle: 875 });
    expect(pct).toBeCloseTo(25, 6);
  });

  test("guards divide-by-zero", () => {
    expect(systemCpuPct({ total: 1000, idle: 800 }, { total: 1000, idle: 800 })).toBe(0);
  });

  test("fully busy => 100", () => {
    const pct = systemCpuPct({ total: 1000, idle: 800 }, { total: 1100, idle: 800 });
    expect(pct).toBeCloseTo(100, 6);
  });
});

describe("pidCpuPct", () => {
  test("returns 0 on first sighting (non-positive delta)", () => {
    expect(pidCpuPct(500, 500, 1)).toBe(0);
  });

  test("100% of one core: jiffies match wall ticks", () => {
    // 1 wall second at 100 Hz => 100 jiffies fully consumed => 100%.
    expect(pidCpuPct(0, 100, 1)).toBeCloseTo(100, 6);
  });

  test("half a core over 2 seconds", () => {
    // 2 wall seconds => 200 available jiffies; consumed 100 => 50%.
    expect(pidCpuPct(0, 100, 2)).toBeCloseTo(50, 6);
  });

  test("can exceed 100 on multicore", () => {
    // 1 second, 250 jiffies => 250% (2.5 cores).
    expect(pidCpuPct(0, 250, 1)).toBeCloseTo(250, 6);
  });

  test("guards zero wall time", () => {
    expect(pidCpuPct(0, 100, 0)).toBe(0);
  });
});

describe("Sampler", () => {
  function fakeSupervisor(running: RunningModel[]): ISupervisor {
    return {
      list: () => running,
      get: (id: string) => running.find((r) => r.modelId === id),
      start: async () => running[0]!,
      stop: async () => running[0]!,
      ensureReady: async () => running[0]!,
      serverInfo: async () => ({ path: "llama-server", found: true }),
      shutdownAll: async () => {},
    };
  }

  test("snapshot() returns a valid empty-ish snapshot before any tick", () => {
    const s = new Sampler({ supervisor: fakeSupervisor([]) });
    const snap = s.snapshot();
    expect(snap.system).toEqual({ cpuPct: 0, memUsed: 0, memTotal: 0, tempC: null });
    expect(snap.gpus).toEqual([]);
    expect(snap.instances).toEqual([]);
    expect(typeof snap.gpuAvailable).toBe("boolean");
    expect(typeof snap.ts).toBe("number");
  });

  test("start() then stop() does not throw and leaves a snapshot", async () => {
    const s = new Sampler({ supervisor: fakeSupervisor([]), intervalMs: 10_000 });
    s.start();
    // Give the immediate sampleOnce a moment to complete.
    await Bun.sleep(50);
    s.stop();
    const snap = s.snapshot();
    expect(snap.system.memTotal).toBeGreaterThan(0); // real /proc on Linux
    expect(Array.isArray(snap.instances)).toBe(true);
  });

  test("stop() is safe when never started", () => {
    const s = new Sampler({ supervisor: fakeSupervisor([]) });
    expect(() => s.stop()).not.toThrow();
  });
});
