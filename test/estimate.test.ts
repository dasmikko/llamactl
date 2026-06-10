import { describe, expect, test } from "bun:test";
import { estimateUsage, type ModelDims } from "../src/instances/estimate.ts";

// A small model with known dims: 32 layers, 1024 KV dim per layer.
const M: ModelDims = { sizeBytes: 8 * 1024 ** 3, nLayers: 32, kvDim: 1024 };

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

  test("missing model dims flags the KV cache as unknown", () => {
    const e = estimateUsage(
      { sizeBytes: M.sizeBytes, nLayers: null, kvDim: null },
      { model: "m", gpuLayers: 99 },
    );
    expect(e.kvUnknown).toBe(true);
    expect(e.kvBytes).toBe(0);
    // Weights still estimated from the file size.
    expect(e.weightsVramBytes).toBe(M.sizeBytes);
  });
});
