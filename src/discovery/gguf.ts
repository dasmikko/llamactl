/**
 * Minimal GGUF metadata reader. Parses just the header key/value block to
 * extract the model architecture, supported context length, and a coarse kind
 * (text / vision / embedding). Reads only the first chunk of the file — the
 * hyperparameter keys we want come before the large tokenizer arrays — and
 * stops as soon as it has what it needs. Anything unreadable degrades to a
 * filename-based fallback rather than throwing.
 */

import type { ModelKind } from "../types.ts";
import { basename } from "node:path";

export interface GgufMeta {
  arch: string | null;
  contextLength: number | null;
  kind: ModelKind;
  /** Transformer block count ({arch}.block_count), or null. */
  nLayers: number | null;
  /** Per-layer KV dimension (n_head_kv × head_dim), for KV-cache sizing, or null. */
  kvDim: number | null;
  /** Embedding/hidden size ({arch}.embedding_length), for compute-buffer sizing, or null. */
  nEmbd: number | null;
  /** Attention head count ({arch}.attention.head_count), for attention-scratch sizing, or null. */
  nHeads: number | null;
  /**
   * MTP / NextN prediction-layer count ({arch}.nextn_predict_layers), or null
   * when the key is absent. llama.cpp gates `--spec-type draft-mtp` on this
   * being non-zero (`llama_init_from_model`: "context type MTP requested but
   * model doesn't contain MTP layers"), so a file carrying it is the MTP head.
   */
  nextnLayers: number | null;
}

/** GGUF metadata value type tags. */
const T_UINT8 = 0,
  T_INT8 = 1,
  T_UINT16 = 2,
  T_INT16 = 3,
  T_UINT32 = 4,
  T_INT32 = 5,
  T_FLOAT32 = 6,
  T_BOOL = 7,
  T_STRING = 8,
  T_ARRAY = 9,
  T_UINT64 = 10,
  T_INT64 = 11,
  T_FLOAT64 = 12;

/** Byte size of a fixed-width scalar value type, or 0 for variable/unknown. */
function scalarSize(type: number): number {
  switch (type) {
    case T_UINT8:
    case T_INT8:
    case T_BOOL:
      return 1;
    case T_UINT16:
    case T_INT16:
      return 2;
    case T_UINT32:
    case T_INT32:
    case T_FLOAT32:
      return 4;
    case T_UINT64:
    case T_INT64:
    case T_FLOAT64:
      return 8;
    default:
      return 0;
  }
}

/** Architectures that are embedding models rather than text generators. */
const EMBEDDING_ARCHS = new Set(["bert", "nomic-bert", "jina-bert-v2", "gte"]);
/** How many bytes of the header to read; hyperparams sit well within this. */
const READ_BYTES = 1 << 20; // 1 MiB

/** A bounds-checked little-endian cursor over the header bytes. */
class Cursor {
  private off = 0;
  constructor(private readonly view: DataView) {}
  remaining(): number {
    return this.view.byteLength - this.off;
  }
  skip(n: number): void {
    if (n < 0 || this.off + n > this.view.byteLength) throw new RangeError("gguf: out of bounds");
    this.off += n;
  }
  private take(size: number): number {
    if (this.off + size > this.view.byteLength) throw new RangeError("gguf: oob");
    const o = this.off;
    this.off += size;
    return o;
  }
  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }
  u64(): number {
    return Number(this.view.getBigUint64(this.take(8), true));
  }
  /** Read a numeric scalar of the given type, or null if the type isn't numeric. */
  num(type: number): number | null {
    switch (type) {
      case T_UINT8:
        return this.view.getUint8(this.take(1));
      case T_INT8:
        return this.view.getInt8(this.take(1));
      case T_UINT16:
        return this.view.getUint16(this.take(2), true);
      case T_INT16:
        return this.view.getInt16(this.take(2), true);
      case T_UINT32:
        return this.view.getUint32(this.take(4), true);
      case T_INT32:
        return this.view.getInt32(this.take(4), true);
      case T_FLOAT32:
        return this.view.getFloat32(this.take(4), true);
      case T_UINT64:
      case T_INT64:
        return Number(this.view.getBigUint64(this.take(8), true));
      case T_FLOAT64:
        return this.view.getFloat64(this.take(8), true);
      default:
        return null;
    }
  }
  str(): string {
    const len = this.u64();
    const start = this.take(len);
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + start, len);
    return new TextDecoder().decode(bytes);
  }
}

/** Skip a metadata value of the given type without interpreting it. */
function skipValue(c: Cursor, type: number): void {
  if (type === T_STRING) {
    c.str();
    return;
  }
  if (type === T_ARRAY) {
    const elemType = c.u32();
    const len = c.u64();
    if (elemType === T_STRING) {
      for (let i = 0; i < len; i++) c.str();
    } else {
      const sz = scalarSize(elemType);
      if (sz === 0) throw new RangeError("gguf: nested array");
      c.skip(sz * len);
    }
    return;
  }
  const sz = scalarSize(type);
  if (sz === 0) throw new RangeError(`gguf: unknown type ${type}`);
  c.skip(sz);
}

/** Kind fallback from the filename alone (used when metadata is unavailable). */
function kindFromName(path: string): ModelKind {
  return /mmproj/i.test(basename(path)) ? "vision" : "text";
}

/**
 * Parse GGUF header bytes. Detects vision (clip.* keys) and embedding
 * (pooling_type) signals while pulling out architecture and context length,
 * stopping once both are known.
 */
function parseHeader(buf: ArrayBuffer, path: string): GgufMeta {
  const view = new DataView(buf);
  const c = new Cursor(view);

  // Magic "GGUF" (0x47 0x47 0x55 0x46, little-endian uint32 0x46554747).
  if (view.byteLength < 24 || c.u32() !== 0x46554747) {
    return { arch: null, contextLength: null, kind: kindFromName(path), nLayers: null, kvDim: null, nEmbd: null, nHeads: null, nextnLayers: null };
  }
  c.u32(); // version
  c.u64(); // tensor count
  const kvCount = c.u64();

  let arch: string | null = null;
  let contextLength: number | null = null;
  let nextnLayers: number | null = null;
  let sawVision = false;
  let sawPooling = false;
  // Hyperparameters used to size the KV cache. All sit before the tokenizer
  // arrays, so the 1 MiB window covers them; matched by key suffix (the prefix
  // is the architecture name, e.g. "llama.block_count").
  let nLayers: number | null = null;
  let nEmbd: number | null = null;
  let nHead: number | null = null;
  let nHeadKv: number | null = null;
  let keyLength: number | null = null;

  // Read a numeric scalar value for the current key, or skip it if not numeric.
  const readNum = (type: number): number | null => {
    const n = c.num(type);
    if (n === null) skipValue(c, type);
    return n;
  };

  for (let i = 0; i < kvCount; i++) {
    if (c.remaining() < 12) break; // not enough for another key+type in our window
    let key: string;
    let type: number;
    try {
      key = c.str();
      type = c.u32();
    } catch {
      break;
    }

    if (key.startsWith("clip.")) sawVision = true;
    if (/\.pooling_type$/.test(key)) sawPooling = true;

    try {
      if (key === "general.architecture" && type === T_STRING) {
        arch = c.str();
      } else if (/\.context_length$/.test(key)) {
        contextLength = readNum(type) ?? contextLength;
      } else if (/\.block_count$/.test(key)) {
        nLayers = readNum(type) ?? nLayers;
      } else if (/\.embedding_length$/.test(key)) {
        nEmbd = readNum(type) ?? nEmbd;
      } else if (/\.attention\.head_count_kv$/.test(key)) {
        nHeadKv = readNum(type) ?? nHeadKv;
      } else if (/\.attention\.head_count$/.test(key)) {
        nHead = readNum(type) ?? nHead;
      } else if (/\.attention\.key_length$/.test(key)) {
        keyLength = readNum(type) ?? keyLength;
      } else if (/\.nextn_predict_layers$/.test(key)) {
        nextnLayers = readNum(type) ?? nextnLayers;
      } else {
        skipValue(c, type);
      }
    } catch {
      break; // ran past our buffer window; use what we have
    }
  }

  // Per-layer KV dimension = n_head_kv × head_dim. head_dim is the explicit
  // key_length when present, else embedding_length / head_count. n_head_kv
  // defaults to n_head (no GQA); fall back to the full embedding dim otherwise.
  const headDim = keyLength ?? (nEmbd != null && nHead ? nEmbd / nHead : null);
  const headsKv = nHeadKv ?? nHead;
  const kvDim = headsKv != null && headDim != null ? headsKv * headDim : nEmbd;

  if (arch === "clip" || /mmproj/i.test(basename(path))) sawVision = true;

  const kind: ModelKind = sawVision
    ? "vision"
    : sawPooling || (arch !== null && EMBEDDING_ARCHS.has(arch))
      ? "embedding"
      : "text";

  return { arch, contextLength, kind, nLayers, kvDim, nEmbd, nHeads: nHead, nextnLayers };
}

/**
 * Read GGUF metadata for the file at `path`. Never throws — on any read/parse
 * failure it returns a filename-based fallback so discovery stays robust.
 */
export async function readGgufMeta(path: string): Promise<GgufMeta> {
  try {
    const slice = Bun.file(path).slice(0, READ_BYTES);
    const buf = await slice.arrayBuffer();
    return parseHeader(buf, path);
  } catch {
    return { arch: null, contextLength: null, kind: kindFromName(path), nLayers: null, kvDim: null, nEmbd: null, nHeads: null, nextnLayers: null };
  }
}
