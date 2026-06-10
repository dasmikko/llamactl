/**
 * Rough VRAM/RAM estimation for a llama-server launch. Pure and unit-testable.
 *
 * Weights are taken from the GGUF file size (≈ total weight memory); the KV
 * cache is computed from the model's layer count and per-layer KV dimension
 * together with the chosen context size and cache-quant types. These are
 * ballpark figures: they ignore the exact compute-buffer size, `--n-cpu-moe`
 * expert offload, LoRA adapters, and allocator padding. Treat the result as a
 * planning guide, not a guarantee.
 */

import type { LaunchSpec } from "../types.ts";

/** The subset of model metadata the estimate needs. */
export interface ModelDims {
  /** GGUF file size in bytes (≈ total weight memory). */
  sizeBytes: number;
  /** Transformer block count, or null if unknown. */
  nLayers: number | null;
  /** Per-layer KV dimension (n_head_kv × head_dim), or null if unknown. */
  kvDim: number | null;
}

export interface UsageEstimate {
  /** Total estimated GPU memory. */
  vramBytes: number;
  /** Total estimated system RAM. */
  ramBytes: number;
  /** Model weights resident on the GPU. */
  weightsVramBytes: number;
  /** Model weights resident in RAM. */
  weightsRamBytes: number;
  /** KV-cache size (split across GPU/RAM by the offload fraction). */
  kvBytes: number;
  /** True when the KV cache couldn't be computed (missing model dims). */
  kvUnknown: boolean;
}

/** Bytes per element for each KV-cache type (block-quant overhead included). */
const CACHE_BYTES: Record<string, number> = {
  f32: 4,
  f16: 2,
  bf16: 2,
  q8_0: 34 / 32,
  q5_1: 24 / 32,
  q5_0: 22 / 32,
  q4_1: 20 / 32,
  q4_0: 18 / 32,
  iq4_nl: 18 / 32,
};

/** Defaults mirror applyDefaults so the estimate matches what would launch. */
const DEFAULT_CTX = 4096;
const DEFAULT_NGL = 99;
/** Rough fixed GPU overhead (CUDA context + compute buffers) when offloading. */
const GPU_OVERHEAD = 320 * 1024 * 1024;

/**
 * Estimate GPU/RAM usage for running `model` under `spec`. The context size is
 * the total across parallel slots (llama-server splits `--ctx-size` among
 * `--parallel` slots), so parallelism doesn't multiply the KV cache here.
 */
export function estimateUsage(model: ModelDims, spec: LaunchSpec): UsageEstimate {
  const ctx = spec.ctxSize ?? DEFAULT_CTX;
  const ngl = spec.gpuLayers ?? DEFAULT_NGL;
  const bytesK = CACHE_BYTES[spec.cacheTypeK ?? "f16"] ?? 2;
  const bytesV = CACHE_BYTES[spec.cacheTypeV ?? "f16"] ?? 2;

  // Fraction of the model offloaded to the GPU. With a known layer count we
  // clamp ngl/nLayers into [0,1]; otherwise any ngl>0 means "all on GPU".
  const frac =
    model.nLayers && model.nLayers > 0
      ? Math.max(0, Math.min(1, ngl / model.nLayers))
      : ngl > 0
        ? 1
        : 0;

  const weightsVramBytes = Math.round(model.sizeBytes * frac);
  const weightsRamBytes = model.sizeBytes - weightsVramBytes;

  let kvBytes = 0;
  let kvUnknown = true;
  if (model.nLayers && model.kvDim) {
    // K and V caches, each n_layers × ctx × kvDim elements.
    kvBytes = Math.round(model.nLayers * ctx * model.kvDim * (bytesK + bytesV));
    kvUnknown = false;
  }

  const kvVram = Math.round(kvBytes * frac);
  const kvRam = kvBytes - kvVram;
  const overhead = frac > 0 ? GPU_OVERHEAD : 0;

  return {
    vramBytes: weightsVramBytes + kvVram + overhead,
    ramBytes: weightsRamBytes + kvRam,
    weightsVramBytes,
    weightsRamBytes,
    kvBytes,
    kvUnknown,
  };
}
