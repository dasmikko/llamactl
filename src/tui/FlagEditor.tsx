/**
 * Modal form to edit a LaunchSpec (plus an instance name). Hand-rolled
 * controlled inputs via useKeyboard — no text-input dependency. Tab/↑/↓ move
 * between fields, typing edits text fields, ←/→ adjust the choosers (ctx size,
 * cache types, flash attn), Enter submits, Esc cancels.
 */

import { createSignal, createMemo, For, Show, type JSX } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { TextAttributes } from "@opentui/core";
import type { LaunchSpec, LlamaFlag, LlamaServerSpec, Model } from "../types.ts";
import { CACHE_TYPES, CURATED_FLAGS } from "../instances/spec.ts";
import { estimateUsage } from "../instances/estimate.ts";
import { humanBytes } from "./format.ts";
import { windowSlice } from "./Table.tsx";
import { editText, CursorText } from "./textinput.tsx";
import { C } from "./theme.ts";

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
  /**
   * Whether a GPU is present. When false the estimate runs everything in RAM
   * (llama.cpp ignores --gpu-layers on a CPU-only host) and the label shows RAM
   * only. Defaults to true.
   */
  gpuAvailable?: boolean;
  /**
   * Live measured usage of this model's running instance (RSS / attributed
   * VRAM), shown next to the estimate so the two can be compared. Omit when the
   * model isn't running.
   */
  actual?: { rssBytes: number; vramBytes: number };
  /**
   * Flags the active llama-server binary accepts (parsed from --help). When
   * present, every non-curated flag is offered in a searchable "all flags"
   * section below the curated fields. Omit (or empty) to show only the curated
   * fields — the editor degrades gracefully when the binary/help is unavailable.
   */
  flagsSpec?: LlamaServerSpec;
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

/** Width of the flag-name column in the generic "all flags" section. */
const FLAG_LABEL_WIDTH = 24;

/**
 * Truncate a label to `w` columns with a trailing ellipsis. opentui `<text>`
 * wraps to its box width rather than clipping, so a long flag name (e.g.
 * `--control-vector-layer-range`) would spill onto a second line and break the
 * row alignment; truncating keeps every label a single line.
 */
function fitLabel(s: string, w: number): string {
  return s.length > w ? s.slice(0, Math.max(0, w - 1)) + "…" : s;
}

/**
 * A single focusable row, unifying the curated fields with the generic
 * "all flags" list so one focus index + window walks the whole editor:
 * - `field`  — a curated `FieldDef` (existing typed editors)
 * - `search` — the filter box for the generic list
 * - `flag`   — one non-curated llama-server flag (text value or on/off switch)
 */
type NavItem =
  | { kind: "field"; field: FieldDef }
  | { kind: "search" }
  | { kind: "flag"; flag: LlamaFlag };

/** Non-curated flags from the parsed spec, matching the search query. */
function genericFlags(spec: LlamaServerSpec | undefined, query: string): LlamaFlag[] {
  if (!spec) return [];
  const q = query.trim().toLowerCase();
  return spec.flags.filter((f) => {
    if (CURATED_FLAGS.has(f.flag)) return false;
    if (q === "") return true;
    return (
      f.flag.toLowerCase().includes(q) ||
      (f.short?.toLowerCase().includes(q) ?? false) ||
      f.help.toLowerCase().includes(q)
    );
  });
}

export function FlagEditor(props: FlagEditorProps): JSX.Element {
  const showName = (): boolean => props.showName ?? true;
  const gpuAvailable = (): boolean => props.gpuAvailable ?? true;

  // Drop the Name row when editing a model's inline flags so it isn't in the
  // tab order; all field navigation below indexes into this list.
  const fields = createMemo<FieldDef[]>(() =>
    showName() ? FIELDS : FIELDS.filter((f) => f.id !== "name"),
  );

  const [values, setValues] = createSignal<TextValues>({
    name: props.initialName,
    model: props.initialSpec.model,
    alias: props.initialSpec.alias ?? "",
    gpuLayers: numStr(props.initialSpec.gpuLayers),
    nCpuMoe: numStr(props.initialSpec.nCpuMoe),
    threads: numStr(props.initialSpec.threads),
    batchSize: numStr(props.initialSpec.batchSize),
    ubatchSize: numStr(props.initialSpec.ubatchSize),
    parallel: numStr(props.initialSpec.parallel),
    mmproj: props.initialSpec.mmproj ?? "",
    chatTemplate: props.initialSpec.chatTemplate ?? "",
    host: props.initialSpec.host ?? "",
    port: numStr(props.initialSpec.port),
    extraArgs: (props.initialSpec.extraArgs ?? []).join(" "),
  });
  const [focus, setFocus] = createSignal(0);
  // Cursor within the focused plain-text field; reset to end-of-text on
  // navigation. fields[0] is always "name" (or "model" when the name is hidden).
  const [cursor, setCursor] = createSignal(
    fields()[0]?.id === "name" ? props.initialName.length : props.initialSpec.model.length,
  );
  // ctx field: an index into CTX_PRESETS, or CTX_CUSTOM to type a number.
  const [ctxOpt, setCtxOpt] = createSignal(initialCtxOpt(props.initialSpec.ctxSize));
  const [ctxCustom, setCtxCustom] = createSignal(numStr(props.initialSpec.ctxSize));
  // Enum choosers: an index into each field's ENUM_OPTS (0 = neutral/unset).
  const [enumOpt, setEnumOpt] = createSignal<Record<EnumFieldId, number>>({
    cacheTypeK: enumIndex("cacheTypeK", props.initialSpec.cacheTypeK),
    cacheTypeV: enumIndex("cacheTypeV", props.initialSpec.cacheTypeV),
    flashAttn: enumIndex("flashAttn", props.initialSpec.flashAttn),
    reasoning: enumIndex("reasoning", props.initialSpec.reasoning),
    jinja: enumIndex("jinja", props.initialSpec.jinja),
    mlock: enumIndex("mlock", props.initialSpec.mlock),
    mmap: enumIndex("mmap", props.initialSpec.mmap),
  });
  // Generic "all flags" section: a filter query and the edited values. Each value
  // is a string; a boolean switch stores "on" (absent ⇒ off), a value flag stores
  // its text. Seeded from any extraFlags already on the spec (true ⇒ "on").
  const [flagSearch, setFlagSearch] = createSignal("");
  const [extraFlags, setExtraFlags] = createSignal<Record<string, string>>(
    (() => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(props.initialSpec.extraFlags ?? {})) {
        out[k] = v === true ? "on" : v;
      }
      return out;
    })(),
  );

  // The focusable rows: curated fields, then the "all flags" search box and the
  // filtered generic flag rows. The section is always present so it stays
  // discoverable; when there are no flags the search row explains why (daemon not
  // restarted / binary missing / unparseable). One `focus` index walks them all.
  const generic = createMemo(() => genericFlags(props.flagsSpec, flagSearch()));
  const genericTotal = createMemo(() => genericFlags(props.flagsSpec, "").length);
  const navItems = createMemo<NavItem[]>(() => [
    ...fields().map((field) => ({ kind: "field", field }) as NavItem),
    { kind: "search" } as NavItem,
    ...generic().map((flag) => ({ kind: "flag", flag }) as NavItem),
  ]);

  /** The effective ctx size from the current option (preset or custom text). */
  const ctxValue = (): number | undefined =>
    ctxOpt() === CTX_CUSTOM ? parseNum(ctxCustom()) : CTX_PRESETS[ctxOpt()];

  /** The effective value of an enum field (undefined when on the neutral option). */
  const enumValue = (id: EnumFieldId): string | undefined => {
    const i = enumOpt()[id];
    return i === 0 ? undefined : ENUM_OPTS[id][i];
  };

  const submit = (): void => {
    const vals = values();
    const extra = vals.extraArgs
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const spec: LaunchSpec = {
      model: vals.model.trim(),
      alias: vals.alias.trim() === "" ? undefined : vals.alias.trim(),
      ctxSize: ctxValue(),
      gpuLayers: parseNum(vals.gpuLayers),
      nCpuMoe: parseNum(vals.nCpuMoe),
      threads: parseNum(vals.threads),
      batchSize: parseNum(vals.batchSize),
      ubatchSize: parseNum(vals.ubatchSize),
      parallel: parseNum(vals.parallel),
      flashAttn: enumValue("flashAttn") as "on" | "off" | undefined,
      reasoning: enumValue("reasoning") as "on" | "off" | undefined,
      jinja: enumValue("jinja") as "on" | "off" | undefined,
      mlock: enumValue("mlock") as "on" | "off" | undefined,
      mmap: enumValue("mmap") as "on" | "off" | undefined,
      cacheTypeK: enumValue("cacheTypeK"),
      cacheTypeV: enumValue("cacheTypeV"),
      mmproj: vals.mmproj.trim() === "" ? undefined : vals.mmproj.trim(),
      chatTemplate: vals.chatTemplate.trim() === "" ? undefined : vals.chatTemplate.trim(),
      host: vals.host.trim() === "" ? undefined : vals.host.trim(),
      port: parseNum(vals.port),
      extraArgs: extra.length > 0 ? extra : undefined,
      extraFlags: collectExtraFlags(),
    };
    const name = vals.name.trim() === "" ? undefined : vals.name.trim();
    props.onSubmit({ name, spec });
  };

  /**
   * Build the spec's `extraFlags` map from the generic section's edits: boolean
   * switches set to "on" become `true`, value flags with non-empty text become
   * that string. Entries from the original spec whose flag the current binary
   * doesn't list are preserved verbatim, so editing on one binary never silently
   * drops flags meaningful to another.
   */
  const collectExtraFlags = (): Record<string, string | true> | undefined => {
    const known = new Map((props.flagsSpec?.flags ?? []).map((f) => [f.flag, f]));
    const out: Record<string, string | true> = {};
    for (const [flag, raw] of Object.entries(extraFlags())) {
      if (CURATED_FLAGS.has(flag)) continue;
      const def = known.get(flag);
      const takesValue = def ? def.takesValue : raw !== "on"; // unknown ⇒ infer
      if (!takesValue) {
        if (raw === "on") out[flag] = true;
      } else {
        const t = raw.trim();
        if (t !== "") out[flag] = t;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  /** On focus change, put the cursor at the end of the newly-focused text field. */
  const focusField = (idx: number): void => {
    setFocus(idx);
    const it = navItems()[idx];
    if (!it) return;
    if (it.kind === "search") setCursor(flagSearch().length);
    else if (it.kind === "flag" && it.flag.takesValue)
      setCursor((extraFlags()[it.flag.flag] ?? "").length);
    else if (it.kind === "field" && !isEnumField(it.field.id) && it.field.id !== "ctxSize") {
      setCursor(values()[it.field.id as TextFieldId].length);
    }
  };

  useKeyboard((key) => {
    const items = navItems();
    const item = items[focus()];
    if (!item) return;

    if (key.name === "escape") {
      props.onCancel();
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      submit();
      return;
    }
    if (key.name === "tab" || key.name === "down") {
      focusField((focus() + 1) % items.length);
      return;
    }
    if (key.name === "up") {
      focusField((focus() - 1 + items.length) % items.length);
      return;
    }

    // Generic "all flags" section.
    if (item.kind === "search") {
      const next = editText({ value: flagSearch(), cursor: cursor() }, key);
      if (next) {
        setFlagSearch(next.value);
        setCursor(next.cursor);
      }
      return;
    }
    if (item.kind === "flag") {
      const f = item.flag;
      if (!f.takesValue) {
        // Boolean switch: ←/→/space toggles between on and off (absent).
        if (key.name === "left" || key.name === "right" || key.sequence === " ") {
          setExtraFlags((m) => ({ ...m, [f.flag]: m[f.flag] === "on" ? "off" : "on" }));
        }
        return;
      }
      const next = editText({ value: extraFlags()[f.flag] ?? "", cursor: cursor() }, key);
      if (next) {
        setExtraFlags((m) => ({ ...m, [f.flag]: next.value }));
        setCursor(next.cursor);
      }
      return;
    }

    const field = item.field;

    // Ctx size: ←/→ scroll through presets and into "Custom"; on Custom, type digits.
    if (field.id === "ctxSize") {
      if (key.name === "left") {
        setCtxOpt((o) => Math.max(0, o - 1));
        return;
      }
      if (key.name === "right") {
        if (ctxOpt() < CTX_CUSTOM) {
          const next = ctxOpt() + 1;
          // Entering Custom from the last preset: seed the number with that
          // preset so the value reads continuously, ready to tweak.
          if (next === CTX_CUSTOM) setCtxCustom(String(CTX_PRESETS[CTX_CUSTOM - 1]));
          setCtxOpt(next);
        }
        return;
      }
      if (ctxOpt() === CTX_CUSTOM) {
        if (key.name === "backspace" || key.name === "delete") {
          setCtxCustom((s) => s.slice(0, -1));
          return;
        }
        const input = key.sequence;
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
      if (key.name === "left") {
        setEnumOpt((e) => ({ ...e, [id]: Math.max(0, e[id] - 1) }));
        return;
      }
      if (key.name === "right") {
        setEnumOpt((e) => ({ ...e, [id]: Math.min(max, e[id] + 1) }));
        return;
      }
      return; // ignore other keys while on a chooser
    }

    // Plain text field: cursor movement + editing. Numeric fields reject
    // anything but digits so they can't hold an un-parseable value.
    const key2 = field.id as TextFieldId;
    const accept = NUMERIC_FIELDS.has(key2)
      ? (text: string) => /^[0-9]+$/.test(text)
      : undefined;
    const next = editText({ value: values()[key2], cursor: cursor() }, key, accept);
    if (next) {
      setValues((v) => ({ ...v, [key2]: next.value }));
      setCursor(next.cursor);
    }
  });

  /** A label + scrollable value row (used by the ctx and enum choosers). */
  const chooserRow = (
    f: FieldDef,
    focused: boolean,
    inner: string,
    canLeft: boolean,
    canRight: boolean,
  ): JSX.Element => (
    <box flexDirection="row">
      <box width={13} flexDirection="row">
        <text fg={focused ? C.accent : undefined}>
          {(focused ? "› " : "  ") + f.label}
        </text>
      </box>
      <text fg={focused ? C.accent : undefined}>
        {(focused && canLeft ? "‹ " : "  ") + inner + (focused && canRight ? " ›" : "")}
      </text>
    </box>
  );

  // Window the row list when it won't all fit, keeping the focused row in view.
  // Chrome inside the box is the border (2) + title (1) + the estimate block
  // (marginTop + line = 2) + the hint line (1); reserve one more line for the
  // scroll indicator.
  const capacity = createMemo<number | undefined>(() =>
    props.availableHeight != null ? Math.max(1, props.availableHeight - 6) : undefined,
  );
  const scrolling = createMemo(() => {
    const cap = capacity();
    return cap != null && navItems().length > cap;
  });
  const slice = createMemo<{ start: number; end: number }>(() => {
    const cap = capacity();
    return scrolling() && cap != null
      ? windowSlice(navItems().length, focus(), Math.max(1, cap - 1))
      : { start: 0, end: navItems().length };
  });
  const start = (): number => slice().start;
  const end = (): number => slice().end;
  const visibleItems = createMemo<NavItem[]>(() => navItems().slice(start(), end()));
  const hiddenAbove = (): number => start();
  const hiddenBelow = (): number => navItems().length - end();

  const showInfo = (): boolean => (props.availableWidth ?? 0) >= 56;
  const infoWidth = (): number =>
    Math.max(24, Math.min(46, Math.floor((props.availableWidth ?? 80) * 0.42)));

  // Columns left for a value: the modal inner width (less the round border +
  // paddingX = 4), minus the side panel when shown (its marginLeft 2 + left
  // border 1 + paddingLeft 2 + infoWidth), minus the label column. The trailing
  // -1 keeps the scroll window a hair under the real space so it can't spill and
  // wrap — values horizontally scroll rather than truncate to "…".
  const formWidth = (): number =>
    (props.availableWidth ?? 80) - 4 - (showInfo() ? infoWidth() + 5 : 0);
  const valueWidth = (): number => Math.max(8, formWidth() - 13 - 1);
  const flagValueWidth = (): number => Math.max(8, formWidth() - FLAG_LABEL_WIDTH - 1);

  // The side panel describes the focused row: a curated field's help, the flag
  // filter, or a generic flag's --help text.
  const focusedItem = (): NavItem | undefined => navItems()[focus()];
  const info = (): FieldInfo | undefined => {
    const fi = focusedItem();
    return fi?.kind === "field" ? INFO[fi.field.id] : undefined;
  };

  // Live memory estimate from the model's GGUF dims and the current flags.
  const estimate = createMemo(() => {
    const m = props.model;
    if (!m) return null;
    return estimateUsage(
      {
        sizeBytes: m.sizeBytes,
        nLayers: m.nLayers,
        kvDim: m.kvDim,
        nEmbd: m.nEmbd,
        nHeads: m.nHeads,
      },
      {
        model: values().model,
        ctxSize: ctxValue(),
        gpuLayers: parseNum(values().gpuLayers),
        ubatchSize: parseNum(values().ubatchSize),
        cacheTypeK: enumValue("cacheTypeK"),
        cacheTypeV: enumValue("cacheTypeV"),
        flashAttn: enumValue("flashAttn") as "on" | "off" | undefined,
      },
      { gpuAvailable: gpuAvailable() },
    );
  });

  /** Render one curated field row (ctx scroller, enum chooser, or text input). */
  const renderField = (f: FieldDef, focused: boolean): JSX.Element => {
    if (f.id === "ctxSize") {
      const isCustom = ctxOpt() === CTX_CUSTOM;
      const inner = isCustom
        ? `custom: ${ctxCustom()}${focused ? "▏" : ""}`
        : String(CTX_PRESETS[ctxOpt()]);
      return chooserRow(f, focused, inner, ctxOpt() > 0, ctxOpt() < CTX_CUSTOM);
    }
    if (isEnumField(f.id)) {
      const opts = ENUM_OPTS[f.id];
      const idx = enumOpt()[f.id];
      return chooserRow(f, focused, opts[idx]!, idx > 0, idx < opts.length - 1);
    }
    return (
      <box flexDirection="row">
        <box width={13} flexDirection="row">
          <text fg={focused ? C.accent : undefined}>
            {fitLabel((focused ? "› " : "  ") + f.label, 13)}
          </text>
        </box>
        <CursorText
          value={values()[f.id as TextFieldId]}
          cursor={cursor()}
          focused={focused}
          width={valueWidth()}
        />
      </box>
    );
  };

  /** Render one generic flag row: an on/off switch, or a text value input. */
  const renderFlag = (flag: LlamaFlag, focused: boolean): JSX.Element => {
    const label = (focused ? "› " : "  ") + flag.flag;
    const value = extraFlags()[flag.flag] ?? "";
    return (
      <box flexDirection="row">
        {/* wrap="truncate-end" dropped: relies on the width={FLAG_LABEL_WIDTH} box. */}
        <box width={FLAG_LABEL_WIDTH} flexDirection="row" overflow="hidden">
          {/* Truncate two columns short of the box so there's always a gap before
              the value, even for a flag name that fills the column. */}
          <text fg={focused ? C.accent : undefined}>{fitLabel(label, FLAG_LABEL_WIDTH - 2)}</text>
        </box>
        <Show
          when={flag.takesValue}
          fallback={
            <text fg={focused ? C.accent : value === "on" ? C.success : undefined}>
              {(focused ? "‹ " : "  ") + (value === "on" ? "on" : "off") + (focused ? " ›" : "")}
            </text>
          }
        >
          <CursorText
            value={value}
            cursor={cursor()}
            focused={focused}
            width={flagValueWidth()}
            placeholder={flag.valueHint}
          />
        </Show>
      </box>
    );
  };

  const form = (
    <box flexDirection="column" flexGrow={1}>
      <For each={visibleItems()}>
        {(it, vi) => {
          const focused = (): boolean => start() + vi() === focus();
          return (
            <Show
              when={it.kind === "field"}
              fallback={
                <Show
                  when={it.kind === "flag"}
                  fallback={
                    // Search row, headed by an "all flags" divider.
                    <box flexDirection="column">
                      <text fg={C.text} attributes={TextAttributes.DIM}>
                        {`── all flags${
                          props.flagsSpec?.version ? ` · llama-server ${props.flagsSpec.version}` : ""
                        } ──`}
                      </text>
                      <box flexDirection="row">
                        <box width={FLAG_LABEL_WIDTH} flexDirection="row">
                          <text fg={focused() ? C.accent : undefined}>
                            {(focused() ? "› " : "  ") + "search"}
                          </text>
                        </box>
                        <CursorText
                          value={flagSearch()}
                          cursor={cursor()}
                          focused={focused()}
                          width={flagValueWidth()}
                          placeholder="filter by name or description…"
                        />
                      </box>
                      <Show when={generic().length === 0}>
                        <text fg={C.text} attributes={TextAttributes.DIM}>
                          {"  " +
                            (genericTotal() > 0
                              ? "no flags match the filter"
                              : props.flagsSpec == null
                                ? "flags unavailable — restart the daemon (llamactl daemon stop) to enable"
                                : props.flagsSpec.version
                                  ? "couldn't read this binary's flags from --help"
                                  : "llama-server not found — set llamaServerPath or activate an install")}
                        </text>
                      </Show>
                    </box>
                  }
                >
                  {renderFlag((it as { kind: "flag"; flag: LlamaFlag }).flag, focused())}
                </Show>
              }
            >
              {renderField((it as { kind: "field"; field: FieldDef }).field, focused())}
            </Show>
          );
        }}
      </For>
      <Show when={scrolling()}>
        <text fg={C.text} attributes={TextAttributes.DIM}>
          {(hiddenAbove() > 0 ? `↑ ${hiddenAbove()} more` : "") +
            (hiddenAbove() > 0 && hiddenBelow() > 0 ? "   " : "") +
            (hiddenBelow() > 0 ? `↓ ${hiddenBelow()} more` : "")}
        </text>
      </Show>
    </box>
  );

  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={C.border}
      backgroundColor={C.surface}
      paddingX={1}
      width={props.availableWidth}
      height={props.availableHeight}
    >
      <text fg={C.text} attributes={TextAttributes.BOLD}>{props.title}</text>
      {/* The field/info area flexes and clips, so the estimate + footer below it
          stay pinned to the bottom of the panel even if a windowed row renders
          more than one line (e.g. the multi-line "all flags" search row). */}
      <box flexDirection="row" flexGrow={1} overflow="hidden">
        {form}
        <Show when={showInfo()}>
          <box
            flexDirection="column"
            width={infoWidth()}
            marginLeft={2}
            paddingLeft={2}
            border={["left"]}
            borderStyle="rounded"
            borderColor={C.border}
          >
            <Show
              when={info() && focusedItem()?.kind === "field"}
              fallback={
                <Show
                  when={focusedItem()?.kind === "flag"}
                  fallback={
                    <>
                      <text fg={C.accent} attributes={TextAttributes.BOLD}>
                        All flags
                      </text>
                      <text fg={C.text} attributes={TextAttributes.DIM}>llama-server --help</text>
                      <box marginTop={1} flexDirection="row">
                        <text fg={C.text}>
                          Every flag the active binary accepts, beyond the curated fields above. Type
                          to filter; ↑↓ to move; ←/→ or space toggles a switch.
                        </text>
                      </box>
                    </>
                  }
                >
                  {(() => {
                    const fi = focusedItem() as { kind: "flag"; flag: LlamaFlag };
                    return (
                      <>
                        <text fg={C.accent} attributes={TextAttributes.BOLD}>
                          {fi.flag.flag + (fi.flag.short ? `, ${fi.flag.short}` : "")}
                        </text>
                        <text fg={C.text} attributes={TextAttributes.DIM}>
                          {fi.flag.takesValue
                            ? `takes a value${fi.flag.valueHint ? `: ${fi.flag.valueHint}` : ""}`
                            : "on/off switch (←/→ or space)"}
                        </text>
                        <Show when={fi.flag.help}>
                          <box marginTop={1} flexDirection="row">
                            <text fg={C.text}>{fi.flag.help}</text>
                          </box>
                        </Show>
                        <Show when={fi.flag.default}>
                          <box marginTop={1} flexDirection="row">
                            <text fg={C.text} attributes={TextAttributes.DIM}>{`default: ${fi.flag.default}`}</text>
                          </box>
                        </Show>
                      </>
                    );
                  })()}
                </Show>
              }
            >
              {(() => {
                const fi = focusedItem() as { kind: "field"; field: FieldDef };
                const fInfo = info()!;
                return (
                  <>
                    <text fg={C.accent} attributes={TextAttributes.BOLD}>
                      {fi.field.label}
                    </text>
                    <text fg={C.text} attributes={TextAttributes.DIM}>{fInfo.flag}</text>
                    <box marginTop={1} flexDirection="row">
                      <text fg={C.text}>{fInfo.desc}</text>
                    </box>
                    <Show when={fInfo.note}>
                      <box marginTop={1} flexDirection="row">
                        <text fg={C.text} attributes={TextAttributes.DIM}>{fInfo.note}</text>
                      </box>
                    </Show>
                  </>
                );
              })()}
            </Show>
          </box>
        </Show>
      </box>
      <box marginTop={1} flexDirection="row">
        <Show
          when={estimate()}
          fallback={
            <text fg={C.text} attributes={TextAttributes.DIM}>≈ estimate unavailable (model not found)</text>
          }
        >
          {/* wrap="truncate-end" dropped: clipped by the parent box width. The
              former nested <Text> runs are flattened into sibling <text>. */}
          <text fg={C.accent2}>≈ </text>
          <Show
            when={gpuAvailable()}
            fallback={
              <>
                <text fg={C.text} attributes={TextAttributes.BOLD}>{humanBytes(estimate()!.ramBytes)}</text>
                <text fg={C.text} attributes={TextAttributes.DIM}> RAM (CPU-only — no GPU)</text>
              </>
            }
          >
            <text fg={C.text} attributes={TextAttributes.BOLD}>{humanBytes(estimate()!.vramBytes)}</text>
            <text fg={C.text} attributes={TextAttributes.DIM}> VRAM · </text>
            <text fg={C.text} attributes={TextAttributes.BOLD}>{humanBytes(estimate()!.ramBytes)}</text>
            <text fg={C.text} attributes={TextAttributes.DIM}> RAM</text>
          </Show>
          <text fg={C.text} attributes={TextAttributes.DIM}>
            {`   (weights ${humanBytes(props.model!.sizeBytes)} · KV ${
              estimate()!.kvUnknown ? "n/a" : humanBytes(estimate()!.kvBytes)
            })`}
          </text>
          <Show when={props.actual}>
            <text fg={C.success}>
              {`   · live ${humanBytes(props.actual!.rssBytes)} RAM${
                gpuAvailable() ? ` · ${humanBytes(props.actual!.vramBytes)} VRAM` : ""
              }`}
            </text>
          </Show>
        </Show>
      </box>
      <box flexDirection="row">
        <text fg={C.text} attributes={TextAttributes.DIM}>Tab/↑↓ move · ←/→ adjust · Enter save · Esc cancel</text>
      </box>
    </box>
  );
}
