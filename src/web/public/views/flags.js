/**
 * The launch-flag editor — the web counterpart of src/tui/FlagEditor.tsx. The
 * curated fields (with their help text and enum choosers) come first, then
 * every other flag the active llama-server binary advertises in `--help`, which
 * lands in `spec.extraFlags`. A live VRAM/RAM estimate is computed with the
 * shared `estimateUsage`, and the spec is validated with the shared
 * `validateSpec` before it is saved or launched.
 *
 * Layout: one field per line in a single scrolling column, grouped under
 * headings. Twenty-odd fields in a two-column grid read as a wall — a list is
 * scannable, and grouping means you can skip to the part you came for. The
 * estimate is pinned in the footer rather than living at the end of the list,
 * since its whole value is watching it move as you edit.
 */

import { CACHE_TYPES, CURATED_FLAGS, validateSpec } from "/mod/instances/spec.js";
import { estimateUsage } from "/mod/instances/estimate.js";
import { el, field, select, checkboxGroup, bytes } from "../lib/dom.js";
import { state, gpuAvailable } from "../lib/store.js";
import { openModal, closeModal } from "./modal.js";

/**
 * Curated fields, grouped by what you'd come to the editor to change. Every
 * field the TUI's FlagEditor has is here; only the ordering differs, so
 * related flags (the two cache types, the two batch sizes) sit together.
 */
const SECTIONS = [
  {
    title: "Context and memory",
    fields: [
      { id: "ctxSize", label: "Ctx size", type: "ctx", flag: "-c, --ctx-size",
        help: "Context window in tokens. Default 4096. Pick a common size or type any value." },
      { id: "gpuLayers", label: "GPU layers", type: "number", flag: "-ngl, --gpu-layers",
        help: "Layers offloaded to the GPU. Default 99 (all). 0 = CPU only." },
      { id: "nCpuMoe", label: "CPU MoE layers", type: "number", flag: "--n-cpu-moe",
        help: "Keep the first N layers' MoE expert weights on the CPU to save VRAM." },
      { id: "cacheTypeK", label: "KV cache K", type: "enum", options: ["default", ...CACHE_TYPES],
        flag: "--cache-type-k", help: "KV-cache type for keys. Quantizing shrinks cache memory. Default f16." },
      { id: "cacheTypeV", label: "KV cache V", type: "enum", options: ["default", ...CACHE_TYPES],
        flag: "--cache-type-v", help: "KV-cache type for values. Quantized V usually needs flash attention on." },
      { id: "mlock", label: "Lock in RAM", type: "enum", options: ["off", "on"], flag: "--mlock",
        help: "Lock the model in RAM so the OS can't swap it out. Off by default." },
      { id: "mmap", label: "Memory-map", type: "enum", options: ["on", "off"], flag: "--no-mmap",
        help: "Memory-map the model rather than loading it fully. off ⇒ passes --no-mmap." },
    ],
  },
  {
    title: "Throughput",
    fields: [
      { id: "threads", label: "Threads", type: "number", flag: "-t, --threads",
        help: "CPU threads used for generation. Default: physical core count." },
      { id: "batchSize", label: "Batch size", type: "number", flag: "-b, --batch-size",
        help: "Logical batch size for prompt processing. Default 2048." },
      { id: "ubatchSize", label: "uBatch size", type: "number", flag: "-ub, --ubatch-size",
        help: "Physical (micro) batch size. Default 512." },
      { id: "parallel", label: "Parallel slots", type: "number", flag: "-np, --parallel",
        help: "Request slots served concurrently (splits the context across slots). Default 1." },
      { id: "flashAttn", label: "Flash attn", type: "enum", options: ["auto", "on", "off"],
        flag: "-fa, --flash-attn", help: "Faster, lower-memory attention on supported GPUs." },
    ],
  },
  {
    title: "Chat behaviour",
    fields: [
      { id: "alias", label: "Alias", type: "text", flag: "-a, --alias",
        help: "Model name reported to API clients, e.g. in GET /v1/models." },
      { id: "jinja", label: "Jinja engine", type: "enum", options: ["default", "on", "off"],
        flag: "--jinja / --no-jinja", help: "Jinja chat-template engine. Enabled by default." },
      { id: "reasoning", label: "Reasoning", type: "enum", options: ["auto", "on", "off"],
        flag: "--reasoning", help: "Reasoning/thinking output. auto detects from the chat template." },
      { id: "chatTemplate", label: "Chat template", type: "text", flag: "--chat-template",
        help: "Built-in template name (e.g. chatml) or a full Jinja string." },
    ],
  },
  {
    // None of these except the draft model are LaunchSpec fields — they live in
    // extraFlags, which is where the supervisor already reads --spec-type to
    // decide whether to auto-fill an MTP head. Each `extra*` field only renders
    // when the active binary actually advertises the flag, so an older build
    // can't be handed an argument it will reject.
    title: "Speculative decoding",
    fields: [
      { flag: "--spec-type", label: "Spec type", type: "extraMulti",
        fallbackOptions: [
          "none", "draft-simple", "draft-eagle3", "draft-mtp",
          "ngram-simple", "ngram-map-k", "ngram-map-k4v", "ngram-mod", "ngram-cache",
        ],
        help: "Speculative decoding types to enable. Several may be combined; llama.cpp takes them comma-separated. draft-mtp uses the model's MTP head." },
      { id: "specDraftModel", label: "Draft model", type: "text", flag: "--spec-draft-model",
        help: "Draft model for speculative decoding. With draft-mtp, leave empty and llamactl auto-finds the repo's MTP head." },
      { flag: "--spec-draft-n-max", label: "Draft tokens", type: "extra", inputType: "number",
        help: "Tokens to draft per step — vLLM calls this num_speculative_tokens. Higher drafts more per step but wastes more on a miss." },
      { flag: "--spec-draft-n-min", label: "Min draft tokens", type: "extra", inputType: "number",
        help: "Minimum draft tokens to use before falling back to normal decoding." },
      { flag: "--spec-draft-ngl", label: "Draft GPU layers", type: "extra", inputType: "text",
        help: "Draft model layers to keep in VRAM: a number, 'auto', or 'all'." },
      { flag: "--spec-draft-type-k", label: "Draft cache K", type: "extraEnum",
        help: "KV-cache type for the draft model's keys." },
      { flag: "--spec-draft-type-v", label: "Draft cache V", type: "extraEnum",
        help: "KV-cache type for the draft model's values." },
      { flag: "--spec-draft-p-min", label: "Min probability", type: "extra", inputType: "text",
        help: "Minimum probability for a drafted token to be accepted (greedy)." },
      { flag: "--spec-draft-p-split", label: "Split probability", type: "extra", inputType: "text",
        help: "Probability threshold at which the draft is split." },
    ],
  },
  {
    // Server-side sampling defaults. An API client that sends its own values
    // overrides these per request; they set the behaviour for clients (and the
    // playground) that don't. Model cards — Unsloth's in particular — publish
    // recommended values per model, and these are the fields they name.
    title: "Sampling defaults",
    fields: [
      { flag: "--temp", label: "Temperature", type: "extra", inputType: "text",
        help: "Randomness. Lower is more deterministic; 0 is greedy." },
      { flag: "--top-k", label: "Top-k", type: "extra", inputType: "number",
        help: "Sample from the k most likely tokens. 0 disables." },
      { flag: "--top-p", label: "Top-p", type: "extra", inputType: "text",
        help: "Nucleus sampling: smallest set of tokens whose probability sums to p. 1.0 disables." },
      { flag: "--min-p", label: "Min-p", type: "extra", inputType: "text",
        help: "Drop tokens below this fraction of the top token's probability. 0.0 disables." },
      { flag: "--repeat-penalty", label: "Repeat penalty", type: "extra", inputType: "text",
        help: "Penalise repeated token sequences. 1.0 disables." },
      { flag: "--repeat-last-n", label: "Repeat window", type: "extra", inputType: "number",
        help: "How many recent tokens the repeat penalty considers. 0 disables, -1 uses the whole context." },
      { flag: "--presence-penalty", label: "Presence penalty", type: "extra", inputType: "text",
        help: "Flat penalty for tokens that already appeared. 0.0 disables." },
      { flag: "--frequency-penalty", label: "Frequency penalty", type: "extra", inputType: "text",
        help: "Penalty scaled by how often a token has appeared. 0.0 disables." },
      { flag: "--seed", label: "Seed", type: "extra", inputType: "number",
        help: "RNG seed. -1 picks a random one per run." },
    ],
  },
  {
    title: "Multimodal",
    fields: [
      { id: "mmproj", label: "Vision projector", type: "text", flag: "--mmproj",
        help: "Multimodal projector file. Required to run vision models." },
    ],
  },
  {
    title: "Network",
    fields: [
      { id: "host", label: "Host", type: "text", flag: "--host",
        help: "Bind address. 127.0.0.1 keeps it local; anything else exposes it." },
      { id: "port", label: "Port", type: "number", flag: "--port",
        help: "Fixed port. Blank ⇒ auto-assigned." },
    ],
  },
];

/**
 * Flags that have a dedicated field above but are NOT in the shared
 * `CURATED_FLAGS` set (which only covers structured LaunchSpec fields). They
 * still live in `extraFlags`, so the generic list has to hide them or the same
 * flag would have two editors fighting over one value.
 */
const EXTRA_CURATED = new Set(
  SECTIONS.flatMap((s) => s.fields)
    .filter((f) => f.type === "extraMulti")
    .map((f) => f.flag),
);

/**
 * Common context sizes offered alongside the free-text box, mirroring the
 * TUI FlagEditor's `CTX_PRESETS`. Presets larger than the model's trained
 * context are dropped, and the model's own maximum is offered when it isn't
 * already one of these — asking for more than the model supports is the most
 * common way to get a launch that fails or silently misbehaves.
 */
const CTX_PRESETS = [2048, 4096, 8192, 16384, 32768, 65536, 131072];

/** "32768 (32K)" — the size with a readable shorthand. */
function ctxLabel(n) {
  return n >= 1024 ? `${n} (${Math.round(n / 1024)}K)` : String(n);
}

/** Enum fields whose neutral (index 0) option means "leave the flag unset". */
const NEUTRAL_IS_UNSET = new Set([
  "cacheTypeK",
  "cacheTypeV",
  "flashAttn",
  "reasoning",
  "jinja",
  "mlock",
  "mmap",
]);

const NUMERIC = new Set([
  "ctxSize",
  "gpuLayers",
  "nCpuMoe",
  "threads",
  "batchSize",
  "ubatchSize",
  "parallel",
  "port",
]);

/** The value shown in an enum chooser for a spec value (neutral when unset). */
function enumValue(f, specValue) {
  return specValue == null || !f.options.includes(specValue) ? f.options[0] : specValue;
}

/**
 * Open the editor.
 *
 * `spec` seeds the form; `name` seeds the profile-name field (omit for a
 * launch-only edit). `onSubmit(spec, name)` receives the assembled spec.
 */
export function openFlagEditor({ title, spec, name, model, showName = true, submitLabel, onSubmit }) {
  // Working copy — mutated as the user edits, read by the estimate and submit.
  const draft = { ...spec, extraFlags: { ...(spec.extraFlags ?? {}) } };
  let profileName = name ?? "";

  const estimateBox = el("div", { className: "estimate" });
  const errorBox = el("div", { className: "warn", hidden: true });

  /** Recompute the live memory estimate from the model's GGUF dims. */
  function updateEstimate() {
    if (!model) {
      estimateBox.replaceChildren(
        el("span", { textContent: "≈ estimate unavailable (model not resolved)" }),
      );
      return;
    }
    const e = estimateUsage(
      {
        sizeBytes: model.sizeBytes,
        nLayers: model.nLayers,
        kvDim: model.kvDim,
        nEmbd: model.nEmbd,
        nHeads: model.nHeads,
      },
      draft,
      { gpuAvailable: gpuAvailable() },
    );
    const gpu = state.stats?.gpus?.[0];
    const parts = [];
    if (gpuAvailable()) {
      // What the host actually has is a tooltip rather than a fourth figure:
      // the footer has to stay one line so the buttons never move.
      parts.push(
        el(
          "span",
          { title: gpu ? `this host has ${bytes(gpu.vramTotal)} of VRAM` : "" },
          "≈ VRAM ",
          el("b", {
            textContent: bytes(e.vramBytes),
            className: gpu && e.vramBytes > gpu.vramTotal ? "warn" : "",
          }),
          gpu ? el("span", { className: "dim", textContent: ` / ${bytes(gpu.vramTotal)}` }) : null,
        ),
      );
    }
    parts.push(el("span", {}, "RAM ", el("b", { textContent: bytes(e.ramBytes) })));
    parts.push(
      el("span", {}, "KV cache ", el("b", { textContent: e.kvUnknown ? "n/a" : bytes(e.kvBytes) })),
    );
    estimateBox.replaceChildren(...parts);
  }

  /** Write a curated field's value into the draft, dropping empty ones. */
  function setField(id, raw) {
    if (raw === "" || raw === undefined) {
      delete draft[id];
    } else if (NUMERIC.has(id)) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n)) draft[id] = n;
      else delete draft[id];
    } else {
      draft[id] = raw;
    }
    updateEstimate();
  }

  /** What the active binary says about a flag, if it has it at all. */
  function advertised(f) {
    return (state.llamaSpec?.flags ?? []).find((p) => p.flag === f.flag);
  }

  /** Choices for a flag, preferring what the active binary actually advertises. */
  function optionsFor(f) {
    return advertised(f)?.enumValues ?? f.fallbackOptions ?? [];
  }

  /**
   * The binary's default, as a placeholder. llama.cpp writes the value and an
   * aside in the same parenthesis — `(default: 40, 0 = disabled)` — and the
   * parser keeps that verbatim, so take only the value up to the first comma.
   * The full text is still in the field's tooltip.
   */
  function placeholderFor(f) {
    const raw = advertised(f)?.default;
    return raw === undefined ? "" : raw.split(",")[0].trim();
  }

  /**
   * Whether to render a field. Curated LaunchSpec fields always show — the
   * daemon owns their translation to argv. A raw `extra*` flag is passed
   * through verbatim, so it's only offered when this binary accepts it; with no
   * parsed spec at all we can't tell, and showing it is the useful default.
   */
  function isAvailable(f) {
    if (!f.type.startsWith("extra")) return true;
    return state.llamaSpec === null || advertised(f) !== undefined;
  }

  /** Write a raw flag's value into extraFlags, dropping empty ones. */
  function setExtra(flag, value) {
    if (value === "") delete draft.extraFlags[flag];
    else draft.extraFlags[flag] = value;
    updateEstimate();
  }

  /**
   * Context size: a preset picker beside a free-text box, both always visible.
   * Choosing a preset fills the box; typing anything sets the picker to
   * "Custom". No mode switch, so an odd value can always be typed and a common
   * one is always one click away.
   */
  function ctxControl(f) {
    const max = model?.contextLength ?? null;
    const presets = CTX_PRESETS.filter((n) => max === null || n <= max);
    // Offer the model's trained maximum when it isn't already a round preset.
    if (max !== null && !presets.includes(max)) presets.push(max);
    presets.sort((a, b) => a - b);

    const input = el("input", {
      type: "number",
      value: draft[f.id] ?? "",
      placeholder: "4096",
      oninput: (e) => {
        setField(f.id, e.target.value);
        picker.value = presets.includes(Number(e.target.value)) ? e.target.value : "custom";
      },
    });

    const picker = select(
      [
        ["custom", "Custom…"],
        ...presets.map((n) => [
          String(n),
          n === max ? `${ctxLabel(n)} — model max` : ctxLabel(n),
        ]),
      ],
      presets.includes(draft[f.id]) ? String(draft[f.id]) : "custom",
      (v) => {
        if (v === "custom") {
          input.focus();
          return;
        }
        input.value = v;
        setField(f.id, v);
      },
    );

    const control = el("div", { className: "ctx-control" }, picker, input);
    if (max !== null) {
      control.append(
        el("span", { className: "dim", textContent: `max ${ctxLabel(max)}` }),
      );
    }
    return control;
  }

  /** One curated field as a list row. */
  function curatedField(f) {
    let control;
    if (f.type === "ctx") {
      control = ctxControl(f);
    } else if (f.type === "extraMulti") {
      // Stored comma-joined in extraFlags, the spelling llama-server wants.
      const current = draft.extraFlags[f.flag];
      const selected = typeof current === "string" ? current.split(",").filter(Boolean) : [];
      control = checkboxGroup(optionsFor(f), selected, (values) => {
        if (values.length === 0) delete draft.extraFlags[f.flag];
        else draft.extraFlags[f.flag] = values.join(",");
      });
    } else if (f.type === "extraEnum") {
      const current = draft.extraFlags[f.flag];
      control = select(
        [["", "(default)"], ...optionsFor(f).map((v) => [v, v])],
        typeof current === "string" ? current : "",
        (v) => setExtra(f.flag, v),
      );
    } else if (f.type === "extra") {
      const current = draft.extraFlags[f.flag];
      control = el("input", {
        type: f.inputType ?? "text",
        value: typeof current === "string" ? current : "",
        // The binary's own default is the placeholder, so an empty box reads as
        // "whatever llama-server does by default" rather than "nothing".
        placeholder: placeholderFor(f),
        oninput: (e) => setExtra(f.flag, e.target.value),
      });
    } else if (f.type === "enum") {
      control = select(
        f.options.map((o) => [o, o]),
        enumValue(f, draft[f.id]),
        (v) => {
          // The neutral option leaves the flag unset, so the daemon's own
          // default applies rather than a value we invented.
          if (v === f.options[0] && NEUTRAL_IS_UNSET.has(f.id)) delete draft[f.id];
          else draft[f.id] = v;
          updateEstimate();
        },
      );
    } else {
      control = el("input", {
        type: f.type === "number" ? "number" : "text",
        value: draft[f.id] ?? "",
        oninput: (e) => setField(f.id, e.target.value),
      });
    }
    // The raw flag is the hint; the prose help is a tooltip rather than a third
    // column, which is most of what made the old grid feel like a wall.
    control.title = `${f.flag}\n\n${f.help}`;
    return field(f.label, control, f.flag);
  }

  const curated = el("div", {});
  for (const section of SECTIONS) {
    // A section whose every field is unsupported by this binary is dropped
    // rather than left as an empty heading.
    const fields = section.fields.filter(isAvailable);
    if (fields.length === 0) continue;
    curated.append(
      el("h3", { className: "editor-section", textContent: section.title }),
      ...fields.map(curatedField),
    );
  }

  const extraArgs = el("input", {
    type: "text",
    value: (draft.extraArgs ?? []).join(" "),
    placeholder: "--some-flag value --another",
    oninput: (e) => {
      const parts = e.target.value.split(/\s+/).filter((s) => s.length > 0);
      if (parts.length > 0) draft.extraArgs = parts;
      else delete draft.extraArgs;
    },
  });

  // ---- the "all flags" section ------------------------------------------
  // Every flag the active binary advertises that isn't already a curated
  // field. Values land in spec.extraFlags, which specToArgs emits verbatim.
  const allFlags = (state.llamaSpec?.flags ?? []).filter(
    (f) => !CURATED_FLAGS.has(f.flag) && !EXTRA_CURATED.has(f.flag),
  );
  const flagList = el("div", {});
  const flagFilter = el("input", {
    type: "search",
    id: "flag-search",
    placeholder: `Search ${allFlags.length} more flags…`,
    oninput: (e) => renderFlagList(e.target.value),
  });

  function renderFlagList(query = "") {
    const q = query.trim().toLowerCase();
    const matches = allFlags.filter(
      (f) =>
        q === "" ||
        f.flag.toLowerCase().includes(q) ||
        (f.help ?? "").toLowerCase().includes(q) ||
        (f.section ?? "").toLowerCase().includes(q),
    );
    // Unfiltered, the full list is hundreds of rows — show only the ones the
    // spec already sets until the user searches, as the TUI's filter does.
    const shown =
      q === "" ? matches.filter((f) => draft.extraFlags[f.flag] !== undefined) : matches.slice(0, 80);

    const rows = shown.map((f) => {
      const current = draft.extraFlags[f.flag];
      let control;
      if (f.takesValue && f.enumValues?.length && f.multiple) {
        // The help said "comma-separated list of …", so several choices can be
        // combined; offer them all rather than making the value be typed.
        control = checkboxGroup(
          f.enumValues,
          typeof current === "string" ? current.split(",").filter(Boolean) : [],
          (values) => {
            if (values.length === 0) delete draft.extraFlags[f.flag];
            else draft.extraFlags[f.flag] = values.join(",");
          },
        );
      } else if (f.takesValue && f.enumValues?.length) {
        // The placeholder named its choices (`{a,b,c}` or a bare `a,b,c`
        // list), so offer them rather than a free-text box — this is driven by
        // what the active binary advertises, so new enum flags pick it up on
        // their own. "" leaves the flag unset.
        control = select(
          [["", "(unset)"], ...f.enumValues.map((v) => [v, v])],
          typeof current === "string" ? current : "",
          (v) => {
            if (v === "") delete draft.extraFlags[f.flag];
            else draft.extraFlags[f.flag] = v;
          },
        );
      } else if (f.takesValue) {
        control = el("input", {
          type: "text",
          value: typeof current === "string" ? current : "",
          placeholder: f.valueHint ?? "value",
          oninput: (e) => {
            if (e.target.value === "") delete draft.extraFlags[f.flag];
            else draft.extraFlags[f.flag] = e.target.value;
          },
        });
      } else {
        control = el("input", {
          type: "checkbox",
          checked: current === true,
          onchange: (e) => {
            if (e.target.checked) draft.extraFlags[f.flag] = true;
            else delete draft.extraFlags[f.flag];
          },
        });
      }
      const help = [f.default ? `default: ${f.default}` : null, f.help].filter(Boolean).join(" · ");
      return field(f.flag, control, help.slice(0, 110));
    });

    if (rows.length === 0) {
      rows.push(
        el("div", {
          className: "dim flag-note",
          textContent:
            q === ""
              ? allFlags.length === 0
                ? "(llama-server --help could not be parsed — use Extra args)"
                : "(type to search the binary's other flags)"
              : "(no matching flag)",
        }),
      );
    }
    flagList.replaceChildren(...rows);
  }
  renderFlagList();

  const nameInput = el("input", {
    type: "text",
    value: profileName,
    placeholder: "defaults to the model name",
    oninput: (e) => {
      profileName = e.target.value;
    },
  });

  const body = el(
    "div",
    { className: "editor-list" },
    el("h3", { className: "editor-section", textContent: "Profile" }),
    showName ? field("Name", nameInput, "not passed to llama-server") : null,
    field(
      "Model",
      el("input", { type: "text", value: draft.model ?? "", disabled: true }),
      "-m, --model",
    ),
    curated,
    el("h3", { className: "editor-section", textContent: "Other llama-server flags" }),
    field("Search flags", flagFilter, state.llamaSpec?.version ?? ""),
    flagList,
    field("Extra args", extraArgs, "appended verbatim"),
    errorBox,
  );

  const submit = el("button", {
    className: "primary",
    textContent: submitLabel ?? "Save",
    onclick: () => {
      // Drop an empty extraFlags map so specs stay tidy.
      if (Object.keys(draft.extraFlags).length === 0) delete draft.extraFlags;
      try {
        // The same validation the daemon runs, so bad input is caught here with
        // a readable message instead of coming back as a 400.
        validateSpec(draft);
      } catch (e) {
        errorBox.hidden = false;
        errorBox.textContent = e.message;
        return;
      }
      onSubmit(draft, profileName.trim() || undefined);
    },
  });

  updateEstimate();

  return openModal({
    title,
    // No subtitle: the title already names the model, and repeating it in the
    // head just adds noise.
    // Wider than the stylesheet default: the widest controls here (the
    // multi-value checkbox groups, the context picker) need the room, and the
    // fixed label and hint columns keep the control from drifting far from its
    // label as the dialog grows.
    width: "min(56rem, 100%)",
    body,
    // The estimate lives in the footer so it stays visible while the field list
    // scrolls — watching it react to a change is the point of having it. The
    // buttons are grouped so a long estimate can't split them across lines.
    footer: [
      estimateBox,
      el(
        "div",
        { className: "modal-actions" },
        el("button", { textContent: "Cancel", onclick: closeModal }),
        submit,
      ),
    ],
  });
}
