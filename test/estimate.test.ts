import { describe, expect, test } from "bun:test";
import { estimateUsage, type ModelDims } from "../src/instances/estimate.ts";

// A small model with known dims: 32 layers, 1024 KV dim per layer, 4096 hidden,
// 32 attention heads.
const M: ModelDims = {
  sizeBytes: 8 * 1024 ** 3,
  nLayers: 32,
  kvDim: 1024,
  nEmbd: 4096,
  nHeads: 32,
};

describe("estimateUsage", () => {
  test("full offload puts weights + KV on the GPU", () => {
    const e = estimateUsage(M, { model: "m", ctxSize: 4096, gpuLayers: 99 });
    // All weights on the GPU; none in RAM.
    expect(e.weightsVramBytes).toBe(M.sizeBytes);
    expect(e.weightsRamBytes).toBe(0);
    // KV = 32 layers × 4096 ctx × 1024 dim × (2+2) bytes (f16 K+V).
    expect(e.kvBytes).toBe(32 * 4096 * 1024 * 4);
    expect(e.kvUnknown).toBe(false);
    expect(e.vramBytes).toBeGreaterThan(e.kvBytes);
  });

  test("gpuLayers 0 keeps everything in RAM, VRAM stays ~0", () => {
    const e = estimateUsage(M, { model: "m", gpuLayers: 0 });
    expect(e.weightsVramBytes).toBe(0);
    expect(e.weightsRamBytes).toBe(M.sizeBytes);
    expect(e.vramBytes).toBe(0); // no overhead when nothing is offloaded
    expect(e.ramBytes).toBeGreaterThanOrEqual(M.sizeBytes);
  });

  test("partial offload splits weights by layer fraction", () => {
    const e = estimateUsage(M, { model: "m", gpuLayers: 16 });
    expect(e.weightsVramBytes).toBe(M.sizeBytes / 2);
    expect(e.weightsRamBytes).toBe(M.sizeBytes / 2);
  });

  test("larger context grows the KV cache linearly", () => {
    const a = estimateUsage(M, { model: "m", ctxSize: 4096, gpuLayers: 99 });
    const b = estimateUsage(M, { model: "m", ctxSize: 8192, gpuLayers: 99 });
    expect(b.kvBytes).toBe(a.kvBytes * 2);
  });

  test("quantized KV cache shrinks the KV bytes", () => {
    const f16 = estimateUsage(M, { model: "m", gpuLayers: 99 });
    const q8 = estimateUsage(M, {
      model: "m",
      gpuLayers: 99,
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
    });
    expect(q8.kvBytes).toBeLessThan(f16.kvBytes);
    // q8_0 ≈ 1.0625 B/elem vs f16 2 B/elem.
    expect(q8.kvBytes).toBeCloseTo(f16.kvBytes * (1.0625 / 2), -2);
  });

  test("no GPU forces everything into RAM regardless of --gpu-layers", () => {
    // Default ngl is 99 (offload all), but with gpuAvailable:false llama.cpp
    // ignores it and runs on the CPU — so weights + KV land entirely in RAM.
    const e = estimateUsage(M, { model: "m", gpuLayers: 99 }, { gpuAvailable: false });
    expect(e.weightsVramBytes).toBe(0);
    expect(e.weightsRamBytes).toBe(M.sizeBytes);
    expect(e.vramBytes).toBe(0); // nothing on the GPU
    expect(e.overheadBytes).toBe(0); // no CUDA context / GPU compute buffer
    // RAM holds weights + KV + the CPU compute buffer.
    expect(e.ramBytes).toBeGreaterThanOrEqual(M.sizeBytes + e.kvBytes);
  });

  test("offload reserves a CUDA-context overhead; CPU-only reserves none", () => {
    const gpu = estimateUsage(M, { model: "m", gpuLayers: 99 });
    expect(gpu.overheadBytes).toBeGreaterThan(0);
    expect(gpu.vramBytes).toBe(gpu.weightsVramBytes + gpu.kvBytes + gpu.overheadBytes);
    const cpu = estimateUsage(M, { model: "m", gpuLayers: 0 });
    expect(cpu.overheadBytes).toBe(0);
  });

  test("disabling flash attention adds an attention-scratch overhead that grows with context", () => {
    const auto = estimateUsage(M, { model: "m", ctxSize: 8192, gpuLayers: 99 });
    const off4k = estimateUsage(M, { model: "m", ctxSize: 8192, gpuLayers: 99, flashAttn: "off" });
    const off8k = estimateUsage(M, { model: "m", ctxSize: 16384, gpuLayers: 99, flashAttn: "off" });
    // flash-attn off materialises the scores buffer; auto/on does not.
    expect(off4k.overheadBytes).toBeGreaterThan(auto.overheadBytes);
    // ...and it scales with context (heads × ubatch × ctx × 4 bytes).
    const extra4k = off4k.overheadBytes - auto.overheadBytes;
    const extra8k = off8k.overheadBytes - auto.overheadBytes;
    expect(extra8k).toBe(extra4k * 2);
    // 32 heads × 512 ubatch × 8192 ctx × 4 bytes.
    expect(extra4k).toBe(32 * 512 * 8192 * 4);
  });

  test("flash attention on matches the auto default (no scores scratch)", () => {
    const on = estimateUsage(M, { model: "m", gpuLayers: 99, flashAttn: "on" });
    const auto = estimateUsage(M, { model: "m", gpuLayers: 99 });
    expect(on.overheadBytes).toBe(auto.overheadBytes);
  });

  test("missing model dims flags the KV cache as unknown", () => {
    const e = estimateUsage(
      { sizeBytes: M.sizeBytes, nLayers: null, kvDim: null, nEmbd: null, nHeads: null },
      { model: "m", gpuLayers: 99 },
    );
    expect(e.kvUnknown).toBe(true);
    expect(e.kvBytes).toBe(0);
    // Weights still estimated from the file size.
    expect(e.weightsVramBytes).toBe(M.sizeBytes);
  });
});
