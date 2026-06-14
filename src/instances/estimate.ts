/**
 * Rough VRAM/RAM estimation for a llama-server launch. Pure and unit-testable.
 *
 * Weights are taken from the GGUF file size (≈ total weight memory); the KV
 * cache is computed from the model's layer count and per-layer KV dimension
 * together with the chosen context size and cache-quant types. GPU overhead is
 * the CUDA runtime reservation plus, without flash attention, the attention
 * scores scratch (which grows with heads × batch × context). These are ballpark
 * figures: they ignore `--n-cpu-moe` expert offload, LoRA adapters, exact
 * compute-graph layout, and allocator padding. Treat the result as a planning
 * guide, not a guarantee.
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
  /** Embedding/hidden size, for the activation buffer; null if unknown. */
  nEmbd: number | null;
  /** Attention head count, for the attention-scores scratch; null if unknown. */
  nHeads: number | null;
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
  /** GPU overhead: CUDA context + compute/attention scratch buffers. */
  overheadBytes: number;
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
/** llama.cpp's default physical (micro) batch — sizes the compute scratch. */
const DEFAULT_UBATCH = 512;
/** Baseline GPU memory the CUDA runtime + cuBLAS reserve once anything offloads. */
const CUDA_CONTEXT = 400 * 1024 * 1024;
/** A handful of hidden-width f32 working tensors live in the compute buffer. */
const ACT_TENSORS = 6;

/** Optional knobs that depend on the host, not the launch spec. */
export interface EstimateOptions {
  /**
   * Whether a GPU is actually present. When false (a CPU-only box), `--gpu-layers`
   * is ignored by llama.cpp and the whole model runs in RAM — so we force the
   * offload fraction to 0 regardless of `spec.gpuLayers`. Defaults to true.
   */
  gpuAvailable?: boolean;
}

/**
 * Estimate GPU/RAM usage for running `model` under `spec`. The context size is
 * the total across parallel slots (llama-server splits `--ctx-size` among
 * `--parallel` slots), so parallelism doesn't multiply the KV cache here. On a
 * host with no GPU, pass `{ gpuAvailable: false }` so everything lands in RAM.
 */
export function estimateUsage(
  model: ModelDims,
  spec: LaunchSpec,
  opts?: EstimateOptions,
): UsageEstimate {
  const gpuAvailable = opts?.gpuAvailable ?? true;
  const ctx = spec.ctxSize ?? DEFAULT_CTX;
  // No GPU ⇒ -ngl is ignored and the model runs on the CPU, so nothing offloads.
  const ngl = gpuAvailable ? (spec.gpuLayers ?? DEFAULT_NGL) : 0;
  const ubatch = spec.ubatchSize ?? DEFAULT_UBATCH;
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

  // The compute buffer: a few hidden-width activation tensors for the physical
  // batch, plus — WITHOUT flash attention — the attention-scores scratch (the KQ
  // matrix in f32) which grows with heads × batch × context. It lives on whatever
  // device runs the layers, so it splits across GPU/RAM by the offload fraction.
  // Flash attention materialises no scores: explicit on/off is honoured, while
  // the "auto" default follows the device — enabled on GPU, disabled on CPU.
  const onGpu = gpuAvailable && frac > 0;
  const flashOn = spec.flashAttn === "on" || (spec.flashAttn == null && onGpu);
  const act = model.nEmbd ? ubatch * model.nEmbd * 4 * ACT_TENSORS : 0;
  const attnScratch = !flashOn && model.nHeads ? model.nHeads * ubatch * ctx * 4 : 0;
  const computeBuffer = act + attnScratch;
  const computeVram = Math.round(computeBuffer * frac);
  const computeRam = computeBuffer - computeVram;
  // A roughly constant CUDA-runtime reservation (cuBLAS handles, etc.) — GPU only.
  const cudaContext = onGpu ? CUDA_CONTEXT : 0;
  const overheadBytes = computeVram + cudaContext;

  return {
    vramBytes: weightsVramBytes + kvVram + overheadBytes,
    ramBytes: weightsRamBytes + kvRam + computeRam,
    weightsVramBytes,
    weightsRamBytes,
    kvBytes,
    overheadBytes,
    kvUnknown,
  };
}
