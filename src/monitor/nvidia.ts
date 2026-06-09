/**
 * Thin wrappers around `nvidia-smi` for the resource monitor. Availability is
 * probed once and cached, so the common no-GPU case (and every repeat call) is
 * free. Every query is bounded by a hard timeout and wrapped in try/catch: a
 * hung or missing `nvidia-smi` degrades to empty results, never a thrown error.
 * CSV parsing is split into exported pure helpers for unit testing.
 */

const MIB = 1024 * 1024;

/** A single GPU's raw stats; memory values in bytes. */
export interface GpuRaw {
  index: number;
  name: string;
  utilPct: number;
  vramUsed: number;
  vramTotal: number;
  /** GPU temperature in °C, or null if the driver didn't report it. */
  tempC: number | null;
}

/** Cached availability probe (null = not yet probed). */
let available: boolean | null = null;

/** True if `nvidia-smi` is on PATH. Probed once, then cached. */
export function nvidiaAvailable(): boolean {
  if (available === null) {
    available = Bun.which("nvidia-smi") !== null;
  }
  return available;
}

/**
 * Run `nvidia-smi` with the given args, returning stdout, or null on timeout /
 * non-zero exit / spawn failure. The subprocess is killed if it overruns
 * `timeoutMs`.
 */
async function runNvidiaSmi(args: string[], timeoutMs = 1500): Promise<string | null> {
  try {
    const proc = Bun.spawn(["nvidia-smi", ...args], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        proc.kill();
        resolve(null);
      }, timeoutMs);
    });
    const run = (async (): Promise<string | null> => {
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      return code === 0 ? out : null;
    })();
    const result = await Promise.race([run, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  } catch {
    return null;
  }
}

/**
 * Parse the CSV produced by `--query-gpu=index,name,utilization.gpu,
 * memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits`.
 * Memory cells are MiB and converted to bytes; temperature is °C (null if the
 * cell is absent or non-numeric). Rows missing the core numbers are skipped.
 */
export function parseGpuCsv(text: string): GpuRaw[] {
  const gpus: GpuRaw[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const cells = line.split(",").map((c) => c.trim());
    if (cells.length < 5) continue;
    const index = Number(cells[0]);
    const name = cells[1] ?? "";
    const utilPct = Number(cells[2]);
    const vramUsedMib = Number(cells[3]);
    const vramTotalMib = Number(cells[4]);
    if (
      !Number.isFinite(index) ||
      !Number.isFinite(utilPct) ||
      !Number.isFinite(vramUsedMib) ||
      !Number.isFinite(vramTotalMib)
    ) {
      continue;
    }
    const temp = cells.length > 5 ? Number(cells[5]) : NaN;
    gpus.push({
      index,
      name,
      utilPct,
      vramUsed: vramUsedMib * MIB,
      vramTotal: vramTotalMib * MIB,
      tempC: Number.isFinite(temp) ? temp : null,
    });
  }
  return gpus;
}

/**
 * Parse the CSV produced by `--query-compute-apps=pid,used_memory
 * --format=csv,noheader,nounits` into a `pid -> bytes` map. Some drivers emit
 * `[N/A]` or `-` for memory; such rows are skipped.
 */
export function parseProcVramCsv(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const cells = line.split(",").map((c) => c.trim());
    if (cells.length < 2) continue;
    const pid = Number(cells[0]);
    const memMib = Number(cells[1]);
    if (!Number.isFinite(pid) || !Number.isFinite(memMib)) continue;
    out.set(pid, memMib * MIB);
  }
  return out;
}

/** Query per-GPU stats; `[]` if nvidia-smi is unavailable or the call fails. */
export async function queryGpus(): Promise<GpuRaw[]> {
  if (!nvidiaAvailable()) return [];
  const out = await runNvidiaSmi([
    "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu",
    "--format=csv,noheader,nounits",
  ]);
  if (out === null) return [];
  return parseGpuCsv(out);
}

/** Query per-pid VRAM use; empty Map if unavailable or the call fails. */
export async function queryProcessVram(): Promise<Map<number, number>> {
  if (!nvidiaAvailable()) return new Map();
  const out = await runNvidiaSmi([
    "--query-compute-apps=pid,used_memory",
    "--format=csv,noheader,nounits",
  ]);
  if (out === null) return new Map();
  return parseProcVramCsv(out);
}
