/**
 * Parse `llama-server --help` into a structured flag list. The help text is NOT
 * a stable contract — its exact columns/wording shift between llama.cpp builds —
 * so the parser is deliberately tolerant: it recognises flag lines, joins their
 * wrapped continuation lines, and silently skips anything it can't classify. A
 * partial result is fine; the caller (and the TUI) degrade gracefully when a
 * flag is missing or the whole parse comes back empty.
 *
 * Pure string logic, no process/filesystem access — the supervisor runs the
 * binary and feeds the captured output here, and tests exercise it with
 * fixtures. The modern format looks like:
 *
 *   ----- common params -----
 *
 *   -t,    --threads N              number of threads to use ... (default: -1)
 *                                   (env: LLAMA_ARG_THREADS)
 *          --rope-scaling {none,linear,yarn}
 *                                   RoPE frequency scaling method
 *          --verbose-prompt         print a verbose prompt before generation
 */

import type { LlamaFlag } from "../types.ts";

/** `----- section name -----` divider between flag groups. */
const SECTION_RE = /^-{2,}\s*(.+?)\s*-{2,}\s*$/;

/**
 * A flag line: up to a little indent, then a comma-separated list of flag tokens
 * (each `-x` / `--xxx`, first char a letter so a continuation like "-1 = off"
 * isn't mistaken for a flag), optionally a value placeholder, then the help. The
 * placeholder/help are pulled apart separately below.
 */
const FLAG_HEAD_RE = /^\s{0,8}(-{1,2}[A-Za-z][\w-]*(?:\s*,\s*-{1,2}[A-Za-z][\w-]*)*)(.*)$/;

/** A value placeholder right after the flags: a braced/bracketed/angled group, or one token. */
const PLACEHOLDER_RE = /^ (\{[^}]*\}|\[[^\]]*\]|<[^>]*>|\S+)(?=\s{2,}|\s*$)/;

/**
 * One option in a bare comma-separated placeholder: lowercase, so a metavar
 * list like `N0,N1,N2` (--tensor-split) isn't mistaken for a set of choices.
 */
const OPTION_TOKEN_RE = /^[a-z][a-z0-9_.-]*$/;

/**
 * Choices parsed out of a value placeholder, or null when it isn't an enum.
 * Two spellings appear in llama.cpp's help:
 *
 *   --rope-scaling {none,linear,yarn}    ← braced
 *   --spec-type none,draft-simple,…      ← bare, comma-separated
 *
 * The bare form is only treated as an enum when every token looks like an
 * option name, so metavars keep their free-text field.
 */
export function parseEnumValues(placeholder: string): string[] | null {
  const braced = /^\{(.*)\}$/.exec(placeholder);
  const inner = braced ? braced[1]! : placeholder;
  const parts = inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (braced) return parts.length > 0 ? parts : null;
  if (parts.length < 2) return null;
  return parts.every((p) => OPTION_TOKEN_RE.test(p)) ? parts : null;
}

/**
 * Choices named in the help prose rather than the placeholder — the third
 * spelling llama.cpp uses:
 *
 *   --spec-draft-type-k TYPE   KV cache data type for K for the draft model
 *                              allowed values: f32, f16, bf16, q8_0, …
 *
 * Returns null when there's no such list, so a plain metavar keeps its text
 * field. Stops at the first bracket so a trailing "(default: f16)" is excluded.
 */
export function parseAllowedValues(help: string): string[] | null {
  const m = /allowed values:\s*([^.()]+)/i.exec(help);
  if (!m) return null;
  const parts = m[1]!
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length < 2) return null;
  return parts.every((p) => OPTION_TOKEN_RE.test(p)) ? parts : null;
}

/**
 * True when the help text says the flag takes several values at once, e.g.
 * `--spec-type`'s "comma-separated list of types of speculative decoding".
 * Editors can then offer a multi-select instead of a single choice.
 */
export function isMultiValued(help: string): boolean {
  return /comma[- ]separated list/i.test(help);
}

interface Draft {
  flag: LlamaFlag;
  /** Help fragments collected from the head line + continuation lines. */
  parts: string[];
}

/** Parse the comma-separated leading flag tokens into short/long forms. */
function splitFlags(list: string): { short?: string; long?: string } {
  const tokens = list.split(",").map((t) => t.trim()).filter(Boolean);
  let short: string | undefined;
  let long: string | undefined;
  for (const t of tokens) {
    if (t.startsWith("--")) {
      if (long === undefined) long = t;
    } else if (t.startsWith("-")) {
      if (short === undefined) short = t;
    }
  }
  return { short, long };
}

/** Finalise a draft: join help parts, strip env notes, lift out the default. */
function finish(draft: Draft): LlamaFlag {
  let help = draft.parts.join(" ").replace(/\s+/g, " ").trim();
  // Pull "(env: …)" notes out entirely — they're noise in a flag editor.
  help = help.replace(/\(env:\s*[^)]*\)/g, "").trim();
  // Lift the first "(default: …)" into its own field; leave the text otherwise.
  if (draft.flag.default === undefined) {
    const m = help.match(/\(default:\s*([^)]*)\)/);
    if (m) draft.flag.default = m[1]!.trim();
  }
  draft.flag.help = help.replace(/\s+/g, " ").trim();
  // These two are stated in the prose, which isn't complete until the
  // continuation lines have been joined — so they're decided here rather than
  // on the head line. A placeholder that already named the choices wins.
  if (!draft.flag.enumValues && draft.flag.takesValue) {
    const allowed = parseAllowedValues(draft.flag.help);
    if (allowed) draft.flag.enumValues = allowed;
  }
  if (draft.flag.enumValues && isMultiValued(draft.flag.help)) draft.flag.multiple = true;
  return draft.flag;
}

/**
 * Parse the body that follows a flag's token list on the head line into an
 * optional placeholder + the inline help fragment.
 */
function parseHead(rest: string): { placeholder?: string; help: string } {
  const m = rest.match(PLACEHOLDER_RE);
  if (m) {
    return { placeholder: m[1]!, help: rest.slice(m[0]!.length).trim() };
  }
  return { help: rest.trim() };
}

export function parseLlamaHelp(text: string): LlamaFlag[] {
  const out: LlamaFlag[] = [];
  const seen = new Set<string>();
  let section: string | undefined;
  let draft: Draft | null = null;

  const flush = (): void => {
    if (draft) {
      const f = finish(draft);
      if (!seen.has(f.flag)) {
        seen.add(f.flag);
        out.push(f);
      }
      draft = null;
    }
  };

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, ""); // drop trailing whitespace only
    if (line.trim() === "") {
      flush(); // a blank line ends a flag's continuation block
      continue;
    }

    const sec = line.match(SECTION_RE);
    if (sec) {
      flush();
      section = sec[1]!.trim();
      continue;
    }

    const head = line.match(FLAG_HEAD_RE);
    if (head) {
      flush();
      const { short, long } = splitFlags(head[1]!);
      const canonical = long ?? short;
      if (!canonical) continue; // no usable flag token
      const { placeholder, help } = parseHead(head[2]!);
      draft = {
        flag: {
          flag: canonical,
          ...(short && short !== canonical ? { short } : {}),
          takesValue: placeholder !== undefined,
          ...(placeholder ? { valueHint: placeholder } : {}),
          ...(() => {
            const values = placeholder ? parseEnumValues(placeholder) : null;
            return values ? { enumValues: values } : {};
          })(),
          help: "",
          ...(section ? { section } : {}),
        },
        parts: help ? [help] : [],
      };
      continue;
    }

    // Otherwise: a continuation/help line for the current flag (indented text).
    if (draft) draft.parts.push(line.trim());
  }

  flush();
  return out;
}
