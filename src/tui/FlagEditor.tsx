/**
 * Modal form to edit a LaunchSpec (plus an instance name). Hand-rolled
 * controlled inputs via useInput — no ink-text-input dependency. Tab/↑/↓ move
 * between fields, typing edits text fields, ←/→ adjust the choosers (ctx size,
 * cache types, flash attn), Enter submits, Esc cancels.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { LaunchSpec } from "../types.ts";
import { CACHE_TYPES } from "../instances/spec.ts";

export interface FlagEditorResult {
  name: string | undefined;
  spec: LaunchSpec;
}

export interface FlagEditorProps {
  /** Title shown at the top, e.g. "Edit profile" / "New instance". */
  title: string;
  initialName: string;
  initialSpec: LaunchSpec;
  onSubmit: (result: FlagEditorResult) => void;
  onCancel: () => void;
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

type TextValues = Record<TextFieldId, string>;

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
  initialSpec,
  onSubmit,
  onCancel,
}: FlagEditorProps): React.ReactElement {
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
    const field = FIELDS[focus];
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
      setFocus((f) => (f + 1) % FIELDS.length);
      return;
    }
    if (key.upArrow) {
      setFocus((f) => (f - 1 + FIELDS.length) % FIELDS.length);
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
    // Ignore other control inputs; append printable characters.
    if (input && !key.ctrl && !key.meta) {
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

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Text bold>{title}</Text>
      {FIELDS.map((f, i) => {
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
            <Text inverse={focused}>
              {values[f.id as TextFieldId]}
              {focused ? "▏" : ""}
            </Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>Tab/↑↓ move · ←/→ adjust · Enter save · Esc cancel</Text>
      </Box>
    </Box>
  );
}
