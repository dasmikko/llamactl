/**
 * Modal form to edit a LaunchSpec (plus an instance name). Hand-rolled
 * controlled inputs via useInput — no ink-text-input dependency. Tab/↑/↓ move
 * between fields, typing edits text fields, ←/→ adjust the choosers (ctx size,
 * cache types, flash attn), Enter submits, Esc cancels.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { LaunchSpec, Model } from "../types.ts";
import { CACHE_TYPES } from "../instances/spec.ts";
import { estimateUsage } from "../instances/estimate.ts";
import { humanBytes } from "./format.ts";
import { windowSlice } from "./Table.tsx";

export interface FlagEditorResult {
  name: string | undefined;
  spec: LaunchSpec;
}

export interface FlagEditorProps {
  /** Title shown at the top, e.g. "Edit profile" / "New instance". */
  title: string;
  initialName: string;
  /**
   * Whether the Name field is shown/editable. Hidden when editing a model's
   * inline flags (the name isn't relevant there); shown for named profiles.
   * Defaults to true.
   */
  showName?: boolean;
  initialSpec: LaunchSpec;
  onSubmit: (result: FlagEditorResult) => void;
  onCancel: () => void;
  /**
   * Total terminal lines available to the editor box. When the fields don't all
   * fit the list windows around the focused field. Omit to render every field.
   */
  availableHeight?: number;
  /**
   * Terminal width. When wide enough, an info panel describing the focused
   * field is shown to the right of the form. Omit for a single-column layout.
   */
  availableWidth?: number;
  /** The resolved model, when known, used for the live VRAM/RAM estimate. */
  model?: Model;
}

/**
 * Field ids in tab order. `ctxSize` is a preset scroller with a custom mode;
 * `cacheTypeK`/`cacheTypeV`/`flashAttn` are enum choosers (←/→); the rest are
 * plain text inputs.
 */
type FieldId =
  | "name"
  | "model"
  | "alias"
  | "ctxSize"
  | "cacheTypeK"
  | "cacheTypeV"
  | "gpuLayers"
  | "nCpuMoe"
  | "threads"
  | "batchSize"
  | "ubatchSize"
  | "parallel"
  | "flashAttn"
  | "reasoning"
  | "jinja"
  | "mlock"
  | "mmap"
  | "mmproj"
  | "chatTemplate"
  | "host"
  | "port"
  | "extraArgs";

/** Fields rendered as a left/right enum chooser (index 0 = neutral/default). */
type EnumFieldId =
  | "cacheTypeK"
  | "cacheTypeV"
  | "flashAttn"
  | "reasoning"
  | "jinja"
  | "mlock"
  | "mmap";
type TextFieldId = Exclude<FieldId, EnumFieldId | "ctxSize">;

interface FieldDef {
  id: FieldId;
  label: string;
}

const FIELDS: FieldDef[] = [
  { id: "name", label: "Name" },
  { id: "model", label: "Model" },
  { id: "alias", label: "Alias" },
  { id: "ctxSize", label: "Ctx size" },
  { id: "cacheTypeK", label: "Cache K" },
  { id: "cacheTypeV", label: "Cache V" },
  { id: "gpuLayers", label: "GPU layers" },
  { id: "nCpuMoe", label: "CPU MoE" },
  { id: "threads", label: "Threads" },
  { id: "batchSize", label: "Batch size" },
  { id: "ubatchSize", label: "uBatch size" },
  { id: "parallel", label: "Parallel" },
  { id: "flashAttn", label: "Flash attn" },
  { id: "reasoning", label: "Reasoning" },
  { id: "jinja", label: "Jinja" },
  { id: "mlock", label: "mlock" },
  { id: "mmap", label: "mmap" },
  { id: "mmproj", label: "mmproj" },
  { id: "chatTemplate", label: "Chat tmpl" },
  { id: "host", label: "Host" },
  { id: "port", label: "Port" },
  { id: "extraArgs", label: "Extra args" },
];

/** Help text shown in the side panel for the highlighted field. */
interface FieldInfo {
  /** The llama-server flag(s) this maps to, or a note when it isn't one. */
  flag: string;
  /** What the flag does. */
  desc: string;
  /** Defaults, ranges, or valid values worth surfacing. */
  note?: string;
}

const INFO: Record<FieldId, FieldInfo> = {
  name: {
    flag: "(profile name)",
    desc: "A label for this saved launch profile. Not passed to llama-server.",
    note: "Blank ⇒ defaults to the model name.",
  },
  model: {
    flag: "-m, --model",
    desc: "The GGUF model to load: an id, name, substring, or absolute path.",
    note: "Required.",
  },
  alias: {
    flag: "-a, --alias",
    desc: "Model name reported to API clients, e.g. in GET /v1/models. Handy when several instances run at once.",
  },
  ctxSize: {
    flag: "-c, --ctx-size",
    desc: "Context window size in tokens. Larger fits more prompt/history but uses more memory.",
    note: "Default 4096. ←/→ for presets or Custom.",
  },
  cacheTypeK: {
    flag: "--cache-type-k",
    desc: "Data type storing the K (keys) of the attention KV-cache. Quantizing it shrinks cache memory — significant at long context — for a small quality cost. q8_0 is a good balance; q4_0 saves the most.",
    note: `Default f16. Options: ${CACHE_TYPES.join(", ")}.`,
  },
  cacheTypeV: {
    flag: "--cache-type-v",
    desc: "Data type for the V (values) of the KV-cache. Same memory/quality trade-off as Cache K. Quantized V types generally require flash attention (-fa on), and best paired with a matching Cache K.",
    note: `Default f16. Options: ${CACHE_TYPES.join(", ")}.`,
  },
  gpuLayers: {
    flag: "-ngl, --gpu-layers",
    desc: "Number of model layers to offload to the GPU.",
    note: "Default 99 (all). 0 = CPU only.",
  },
  nCpuMoe: {
    flag: "--n-cpu-moe",
    desc: "Keep the first N layers' MoE expert weights on the CPU to save VRAM on mixture-of-experts models.",
  },
  threads: {
    flag: "-t, --threads",
    desc: "CPU threads used for generation.",
    note: "Default: physical core count.",
  },
  batchSize: {
    flag: "-b, --batch-size",
    desc: "Logical batch size for prompt processing (tokens per submission).",
    note: "Default 2048.",
  },
  ubatchSize: {
    flag: "-ub, --ubatch-size",
    desc: "Physical (micro) batch size: tokens actually processed per pass. Tune with batch size for throughput.",
    note: "Default 512.",
  },
  parallel: {
    flag: "-np, --parallel",
    desc: "Number of request slots served concurrently. Raise to serve simultaneous clients (splits the context across slots).",
    note: "Default 1.",
  },
  flashAttn: {
    flag: "-fa, --flash-attn",
    desc: "Flash attention: faster, lower-memory attention on supported GPUs.",
    note: "auto lets llama.cpp decide.",
  },
  reasoning: {
    flag: "--reasoning",
    desc: "Toggle reasoning/thinking output for models that support it.",
    note: "auto detects from the chat template.",
  },
  jinja: {
    flag: "--jinja / --no-jinja",
    desc: "Use the Jinja chat-template engine, needed for many chat and tool templates.",
    note: "Enabled by default.",
  },
  mlock: {
    flag: "--mlock",
    desc: "Lock the model in RAM so the OS can't swap it out. Can reduce latency spikes.",
    note: "Off by default.",
  },
  mmap: {
    flag: "--no-mmap",
    desc: "Memory-map the model file rather than loading it fully into RAM. On by default; set off to force a full load.",
    note: "off ⇒ passes --no-mmap.",
  },
  mmproj: {
    flag: "--mmproj",
    desc: "Path to a multimodal projector file. Required to run vision (multimodal) models.",
  },
  chatTemplate: {
    flag: "--chat-template",
    desc: "Override the chat template: a built-in name (e.g. chatml) or a full Jinja string.",
  },
  host: {
    flag: "--host",
    desc: "Address the instance binds to. 127.0.0.1 keeps it local; any other address exposes it on the network.",
    note: "Default 127.0.0.1.",
  },
  port: {
    flag: "--port",
    desc: "Fixed port for the instance.",
    note: "Blank ⇒ auto-assigned.",
  },
  extraArgs: {
    flag: "(passthrough)",
    desc: "Extra llama-server arguments appended verbatim, space-separated. Use for flags without a field here.",
  },
};

type TextValues = Record<TextFieldId, string>;

/** Text fields that accept digits only (mapped to numbers on submit). */
const NUMERIC_FIELDS: ReadonlySet<TextFieldId> = new Set<TextFieldId>([
  "gpuLayers",
  "nCpuMoe",
  "threads",
  "batchSize",
  "ubatchSize",
  "parallel",
  "port",
]);

/**
 * Options for each enum chooser. Index 0 is the neutral choice ("default"/
 * "auto") that leaves the corresponding flag unset; the rest map to a value.
 */
const ENUM_OPTS: Record<EnumFieldId, readonly string[]> = {
  cacheTypeK: ["default", ...CACHE_TYPES],
  cacheTypeV: ["default", ...CACHE_TYPES],
  flashAttn: ["auto", "on", "off"],
  reasoning: ["auto", "on", "off"],
  jinja: ["default", "on", "off"],
  // mlock defaults to off (index 0 ⇒ unset); mmap defaults to on (index 0 ⇒
  // unset), with "off" emitting --no-mmap. Index 0 is always the neutral state.
  mlock: ["off", "on"],
  mmap: ["on", "off"],
};

function isEnumField(id: FieldId): id is EnumFieldId {
  return (
    id === "cacheTypeK" ||
    id === "cacheTypeV" ||
    id === "flashAttn" ||
    id === "reasoning" ||
    id === "jinja" ||
    id === "mlock" ||
    id === "mmap"
  );
}

/** Initial chooser index for a value within its options (0 = neutral/unset). */
function enumIndex(id: EnumFieldId, value: string | undefined): number {
  if (value == null) return 0;
  const i = ENUM_OPTS[id].indexOf(value);
  return i >= 0 ? i : 0;
}

/** Common llama.cpp context sizes the ctx field scrolls through (←/→). */
const CTX_PRESETS = [2048, 4096, 8192, 16384, 32768, 65536, 131072];
/** Index sentinel: one past the presets means "Custom" (type a number). */
const CTX_CUSTOM = CTX_PRESETS.length;

function numStr(n: number | undefined): string {
  return n == null ? "" : String(n);
}

/**
 * Pick the initial ctx option: a matching preset index, else Custom when a
 * non-preset value is set, else default to the 4096 preset.
 */
function initialCtxOpt(ctxSize: number | undefined): number {
  if (ctxSize == null) return CTX_PRESETS.indexOf(4096);
  const idx = CTX_PRESETS.indexOf(ctxSize);
  return idx >= 0 ? idx : CTX_CUSTOM;
}

/** Parse a text field into a number, returning undefined for empty/invalid. */
function parseNum(s: string): number | undefined {
  const t = s.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export function FlagEditor({
  title,
  initialName,
  showName = true,
  initialSpec,
  onSubmit,
  onCancel,
  availableHeight,
  availableWidth,
  model,
}: FlagEditorProps): React.ReactElement {
  // Drop the Name row when editing a model's inline flags so it isn't in the
  // tab order; all field navigation below indexes into this list.
  const fields = showName ? FIELDS : FIELDS.filter((f) => f.id !== "name");
  const [values, setValues] = useState<TextValues>({
    name: initialName,
    model: initialSpec.model,
    alias: initialSpec.alias ?? "",
    gpuLayers: numStr(initialSpec.gpuLayers),
    nCpuMoe: numStr(initialSpec.nCpuMoe),
    threads: numStr(initialSpec.threads),
    batchSize: numStr(initialSpec.batchSize),
    ubatchSize: numStr(initialSpec.ubatchSize),
    parallel: numStr(initialSpec.parallel),
    mmproj: initialSpec.mmproj ?? "",
    chatTemplate: initialSpec.chatTemplate ?? "",
    host: initialSpec.host ?? "",
    port: numStr(initialSpec.port),
    extraArgs: (initialSpec.extraArgs ?? []).join(" "),
  });
  const [focus, setFocus] = useState(0);
  // ctx field: an index into CTX_PRESETS, or CTX_CUSTOM to type a number.
  const [ctxOpt, setCtxOpt] = useState(() => initialCtxOpt(initialSpec.ctxSize));
  const [ctxCustom, setCtxCustom] = useState(() => numStr(initialSpec.ctxSize));
  // Enum choosers: an index into each field's ENUM_OPTS (0 = neutral/unset).
  const [enumOpt, setEnumOpt] = useState<Record<EnumFieldId, number>>(() => ({
    cacheTypeK: enumIndex("cacheTypeK", initialSpec.cacheTypeK),
    cacheTypeV: enumIndex("cacheTypeV", initialSpec.cacheTypeV),
    flashAttn: enumIndex("flashAttn", initialSpec.flashAttn),
    reasoning: enumIndex("reasoning", initialSpec.reasoning),
    jinja: enumIndex("jinja", initialSpec.jinja),
    mlock: enumIndex("mlock", initialSpec.mlock),
    mmap: enumIndex("mmap", initialSpec.mmap),
  }));

  /** The effective ctx size from the current option (preset or custom text). */
  const ctxValue = (): number | undefined =>
    ctxOpt === CTX_CUSTOM ? parseNum(ctxCustom) : CTX_PRESETS[ctxOpt];

  /** The effective value of an enum field (undefined when on the neutral option). */
  const enumValue = (id: EnumFieldId): string | undefined => {
    const i = enumOpt[id];
    return i === 0 ? undefined : ENUM_OPTS[id][i];
  };

  const submit = (): void => {
    const extra = values.extraArgs
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const spec: LaunchSpec = {
      model: values.model.trim(),
      alias: values.alias.trim() === "" ? undefined : values.alias.trim(),
      ctxSize: ctxValue(),
      gpuLayers: parseNum(values.gpuLayers),
      nCpuMoe: parseNum(values.nCpuMoe),
      threads: parseNum(values.threads),
      batchSize: parseNum(values.batchSize),
      ubatchSize: parseNum(values.ubatchSize),
      parallel: parseNum(values.parallel),
      flashAttn: enumValue("flashAttn") as "on" | "off" | undefined,
      reasoning: enumValue("reasoning") as "on" | "off" | undefined,
      jinja: enumValue("jinja") as "on" | "off" | undefined,
      mlock: enumValue("mlock") as "on" | "off" | undefined,
      mmap: enumValue("mmap") as "on" | "off" | undefined,
      cacheTypeK: enumValue("cacheTypeK"),
      cacheTypeV: enumValue("cacheTypeV"),
      mmproj: values.mmproj.trim() === "" ? undefined : values.mmproj.trim(),
      chatTemplate: values.chatTemplate.trim() === "" ? undefined : values.chatTemplate.trim(),
      host: values.host.trim() === "" ? undefined : values.host.trim(),
      port: parseNum(values.port),
      extraArgs: extra.length > 0 ? extra : undefined,
    };
    const name = values.name.trim() === "" ? undefined : values.name.trim();
    onSubmit({ name, spec });
  };

  useInput((input, key) => {
    const field = fields[focus];
    if (!field) return;

    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      submit();
      return;
    }
    if (key.tab || key.downArrow) {
      setFocus((f) => (f + 1) % fields.length);
      return;
    }
    if (key.upArrow) {
      setFocus((f) => (f - 1 + fields.length) % fields.length);
      return;
    }

    // Ctx size: ←/→ scroll through presets and into "Custom"; on Custom, type digits.
    if (field.id === "ctxSize") {
      if (key.leftArrow) {
        setCtxOpt((o) => Math.max(0, o - 1));
        return;
      }
      if (key.rightArrow) {
        if (ctxOpt < CTX_CUSTOM) {
          const next = ctxOpt + 1;
          // Entering Custom from the last preset: seed the number with that
          // preset so the value reads continuously, ready to tweak.
          if (next === CTX_CUSTOM) setCtxCustom(String(CTX_PRESETS[CTX_CUSTOM - 1]));
          setCtxOpt(next);
        }
        return;
      }
      if (ctxOpt === CTX_CUSTOM) {
        if (key.backspace || key.delete) {
          setCtxCustom((s) => s.slice(0, -1));
          return;
        }
        if (input && /^[0-9]+$/.test(input) && !key.ctrl && !key.meta) {
          setCtxCustom((s) => s + input);
          return;
        }
      }
      return; // ignore other keys while on the ctx field
    }

    // Enum choosers (cache K/V, flash attn): ←/→ cycle through the options.
    if (isEnumField(field.id)) {
      const id = field.id;
      const max = ENUM_OPTS[id].length - 1;
      if (key.leftArrow) {
        setEnumOpt((e) => ({ ...e, [id]: Math.max(0, e[id] - 1) }));
        return;
      }
      if (key.rightArrow) {
        setEnumOpt((e) => ({ ...e, [id]: Math.min(max, e[id] + 1) }));
        return;
      }
      return; // ignore other keys while on a chooser
    }

    const key2 = field.id as TextFieldId;
    if (key.backspace || key.delete) {
      setValues((v) => ({ ...v, [key2]: v[key2].slice(0, -1) }));
      return;
    }
    // Ignore other control inputs; append printable characters. Numeric fields
    // reject anything but digits so they can't hold an un-parseable value.
    if (input && !key.ctrl && !key.meta) {
      if (NUMERIC_FIELDS.has(key2) && !/^[0-9]+$/.test(input)) return;
      setValues((v) => ({ ...v, [key2]: v[key2] + input }));
    }
  });

  /** A label + scrollable value row (used by the ctx and enum choosers). */
  const chooserRow = (
    f: FieldDef,
    focused: boolean,
    inner: string,
    canLeft: boolean,
    canRight: boolean,
  ): React.ReactElement => (
    <Box key={f.id}>
      <Box width={13}>
        <Text color={focused ? "cyan" : undefined}>
          {focused ? "› " : "  "}
          {f.label}
        </Text>
      </Box>
      <Text color={focused ? "cyan" : undefined}>
        {focused && canLeft ? "‹ " : "  "}
        {inner}
        {focused && canRight ? " ›" : ""}
      </Text>
    </Box>
  );

  // Window the field list when it won't all fit, keeping the focused field in
  // view. Chrome inside the box is the border (2) + title (1) + the estimate
  // block (marginTop + line = 2) + the hint line (1); reserve one more line for
  // the scroll indicator.
  const capacity =
    availableHeight != null ? Math.max(1, availableHeight - 6) : undefined;
  const scrolling = capacity != null && fields.length > capacity;
  const { start, end } = scrolling
    ? windowSlice(fields.length, focus, Math.max(1, capacity - 1))
    : { start: 0, end: fields.length };
  const visibleFields = fields.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = fields.length - end;

  // The side panel describes the highlighted field. Only show it when the
  // terminal is wide enough to spare the columns; otherwise stay single-column.
  const focusedField = fields[focus]!;
  const info = INFO[focusedField.id];
  const showInfo = (availableWidth ?? 0) >= 56;
  const infoWidth = Math.max(24, Math.min(46, Math.floor((availableWidth ?? 80) * 0.42)));

  // Live memory estimate from the model's GGUF dims and the current flags.
  const estimate = model
    ? estimateUsage(
        { sizeBytes: model.sizeBytes, nLayers: model.nLayers, kvDim: model.kvDim },
        {
          model: values.model,
          ctxSize: ctxValue(),
          gpuLayers: parseNum(values.gpuLayers),
          cacheTypeK: enumValue("cacheTypeK"),
          cacheTypeV: enumValue("cacheTypeV"),
        },
      )
    : null;

  const form = (
    <Box flexDirection="column" flexGrow={1}>
      {visibleFields.map((f, vi) => {
        const i = start + vi;
        const focused = i === focus;

        if (f.id === "ctxSize") {
          const isCustom = ctxOpt === CTX_CUSTOM;
          const inner = isCustom
            ? `custom: ${ctxCustom}${focused ? "▏" : ""}`
            : String(CTX_PRESETS[ctxOpt]);
          return chooserRow(f, focused, inner, ctxOpt > 0, ctxOpt < CTX_CUSTOM);
        }

        if (isEnumField(f.id)) {
          const opts = ENUM_OPTS[f.id];
          const idx = enumOpt[f.id];
          return chooserRow(f, focused, opts[idx]!, idx > 0, idx < opts.length - 1);
        }

        return (
          <Box key={f.id}>
            <Box width={13}>
              <Text color={focused ? "cyan" : undefined}>
                {focused ? "› " : "  "}
                {f.label}
              </Text>
            </Box>
            {/* truncate-start keeps the tail (and cursor) of long paths visible. */}
            <Text inverse={focused} wrap="truncate-start">
              {values[f.id as TextFieldId]}
              {focused ? "▏" : ""}
            </Text>
          </Box>
        );
      })}
      {scrolling ? (
        <Text dimColor>
          {hiddenAbove > 0 ? `↑ ${hiddenAbove} more` : ""}
          {hiddenAbove > 0 && hiddenBelow > 0 ? "   " : ""}
          {hiddenBelow > 0 ? `↓ ${hiddenBelow} more` : ""}
        </Text>
      ) : null}
    </Box>
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      width={availableWidth}
    >
      <Text bold>{title}</Text>
      <Box flexDirection="row">
        {form}
        {showInfo ? (
          <Box
            flexDirection="column"
            width={infoWidth}
            marginLeft={2}
            paddingLeft={2}
            borderStyle="round"
            borderColor="gray"
            borderTop={false}
            borderRight={false}
            borderBottom={false}
          >
            <Text bold color="cyan">
              {focusedField.label}
            </Text>
            <Text dimColor>{info.flag}</Text>
            <Box marginTop={1}>
              <Text>{info.desc}</Text>
            </Box>
            {info.note ? (
              <Box marginTop={1}>
                <Text dimColor>{info.note}</Text>
              </Box>
            ) : null}
          </Box>
        ) : null}
      </Box>
      <Box marginTop={1}>
        {estimate ? (
          <Text wrap="truncate-end">
            <Text color="magenta">≈ </Text>
            <Text bold>{humanBytes(estimate.vramBytes)}</Text>
            <Text dimColor> VRAM · </Text>
            <Text bold>{humanBytes(estimate.ramBytes)}</Text>
            <Text dimColor> RAM</Text>
            <Text dimColor>
              {`   (weights ${humanBytes(model!.sizeBytes)} · KV ${
                estimate.kvUnknown ? "n/a" : humanBytes(estimate.kvBytes)
              })`}
            </Text>
          </Text>
        ) : (
          <Text dimColor>≈ estimate unavailable (model not found)</Text>
        )}
      </Box>
      <Box>
        <Text dimColor>Tab/↑↓ move · ←/→ adjust · Enter save · Esc cancel</Text>
      </Box>
    </Box>
  );
}
