import { describe, expect, test } from "bun:test";
import { parseLlamaHelp } from "../src/llama/help.ts";
import type { LlamaFlag } from "../src/types.ts";

/** A representative slice of modern `llama-server --help` output. */
const HELP = `
----- common params -----

-h,    --help, --usage          print usage and exit
       --version                show version and build info
-t,    --threads N              number of threads to use during generation (default: -1)
                                (env: LLAMA_ARG_THREADS)
-c,    --ctx-size N             size of the prompt context (default: 4096, 0 = loaded from model)
                                (env: LLAMA_ARG_CTX_SIZE)
       --rope-scaling {none,linear,yarn}
                                RoPE frequency scaling method, defaults to linear unless specified by the model
-ngl,  --gpu-layers N           number of layers to store in VRAM (default: 0)
       --verbose-prompt         print a verbose prompt before generation (default: false)
-m,    --model FNAME            model path (default: \`models/$filename\`)
                                (env: LLAMA_ARG_MODEL)

----- server params -----

       --host HOST              ip address to listen (default: 127.0.0.1)
       --no-webui               disable the Web UI
`;

function byFlag(flags: LlamaFlag[], name: string): LlamaFlag {
  const f = flags.find((x) => x.flag === name);
  if (!f) throw new Error(`flag ${name} not parsed; got: ${flags.map((x) => x.flag).join(", ")}`);
  return f;
}

describe("parseLlamaHelp", () => {
  const flags = parseLlamaHelp(HELP);

  test("parses a value flag with short alias and default", () => {
    const t = byFlag(flags, "--threads");
    expect(t.short).toBe("-t");
    expect(t.takesValue).toBe(true);
    expect(t.valueHint).toBe("N");
    expect(t.default).toBe("-1");
    expect(t.help).toContain("number of threads");
  });

  test("strips (env: …) notes from help", () => {
    expect(byFlag(flags, "--ctx-size").help).not.toContain("env:");
    expect(byFlag(flags, "--ctx-size").default).toBe("4096, 0 = loaded from model");
  });

  test("boolean switch has no value", () => {
    const b = byFlag(flags, "--verbose-prompt");
    expect(b.takesValue).toBe(false);
    expect(b.valueHint).toBeUndefined();
    expect(b.default).toBe("false");
  });

  test("enum placeholder is split into choices with help on the next line", () => {
    const r = byFlag(flags, "--rope-scaling");
    expect(r.takesValue).toBe(true);
    expect(r.enumValues).toEqual(["none", "linear", "yarn"]);
    expect(r.help).toContain("RoPE frequency scaling");
  });

  test("first long form is canonical; --help, --usage collapses", () => {
    const h = byFlag(flags, "--help");
    expect(h.short).toBe("-h");
    expect(h.takesValue).toBe(false);
  });

  test("tracks the section a flag appeared under", () => {
    expect(byFlag(flags, "--threads").section).toBe("common params");
    expect(byFlag(flags, "--host").section).toBe("server params");
  });

  test("short flag with letters (-ngl) is captured", () => {
    const g = byFlag(flags, "--gpu-layers");
    expect(g.short).toBe("-ngl");
    expect(g.takesValue).toBe(true);
  });

  test("empty / garbage input yields no flags", () => {
    expect(parseLlamaHelp("")).toEqual([]);
    expect(parseLlamaHelp("no flags here\njust prose\n")).toEqual([]);
  });

  test("a continuation line starting with a dash is not a new flag", () => {
    const out = parseLlamaHelp(
      "-c, --ctx-size N    size of context\n                    -1 means unlimited\n",
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.flag).toBe("--ctx-size");
    expect(out[0]!.help).toContain("-1 means unlimited");
  });
});

/**
 * llama.cpp spells enums two ways. `--rope-scaling {none,linear,yarn}` is the
 * braced form; `--spec-type` lists its choices bare, comma-separated, and its
 * help says the flag takes several of them at once. Editors turn both into
 * pickers, so both have to be recognised — while metavars that merely contain
 * commas (`--tensor-split N0,N1,N2`) must stay free text.
 */
describe("enum and multi-value detection", () => {
  const SPEC_TYPE_HELP = [
    "--spec-type none,draft-simple,draft-eagle3,draft-mtp,ngram-simple",
    "                                        comma-separated list of types of speculative decoding to use (default:",
    "                                        none)",
    "",
    "--tensor-split N0,N1,N2                 fraction of the model to offload to each GPU",
    "       --rope-scaling {none,linear,yarn}",
    "                                        RoPE frequency scaling method",
    "-c, --ctx-size N                        size of the prompt context",
  ].join("\n");

  const flags = parseLlamaHelp(SPEC_TYPE_HELP);

  test("parses a bare comma-separated option list into choices", () => {
    const spec = byFlag(flags, "--spec-type");
    expect(spec.enumValues).toEqual([
      "none",
      "draft-simple",
      "draft-eagle3",
      "draft-mtp",
      "ngram-simple",
    ]);
    expect(spec.takesValue).toBe(true);
  });

  test("marks a 'comma-separated list' flag as multi-valued", () => {
    expect(byFlag(flags, "--spec-type").multiple).toBe(true);
    expect(byFlag(flags, "--rope-scaling").multiple).toBeUndefined();
  });

  test("still parses the braced form", () => {
    expect(byFlag(flags, "--rope-scaling").enumValues).toEqual(["none", "linear", "yarn"]);
  });

  test("a metavar list is not an enum", () => {
    // N0,N1,N2 are placeholders for numbers, not choices to pick from.
    expect(byFlag(flags, "--tensor-split").enumValues).toBeUndefined();
    expect(byFlag(flags, "--ctx-size").enumValues).toBeUndefined();
  });
});

/**
 * A third spelling: the choices live in the help prose rather than the value
 * placeholder. `--spec-draft-type-k TYPE` says "allowed values: f32, f16, …",
 * and only the joined continuation lines contain it.
 */
describe("choices named in the help prose", () => {
  const flags = parseLlamaHelp(
    [
      "--spec-draft-type-k, -ctkd, --cache-type-k-draft TYPE",
      "                                        KV cache data type for K for the draft model",
      "                                        allowed values: f32, f16, bf16, q8_0, q4_0",
      "                                        (default: f16)",
      "",
      "--spec-draft-n-max N                    number of tokens to draft (default: 3)",
    ].join("\n"),
  );

  test("lifts 'allowed values: …' into the choices", () => {
    const k = byFlag(flags, "--spec-draft-type-k");
    expect(k.enumValues).toEqual(["f32", "f16", "bf16", "q8_0", "q4_0"]);
    expect(k.default).toBe("f16");
    expect(k.multiple).toBeUndefined();
  });

  test("a plain metavar keeps its free-text field", () => {
    expect(byFlag(flags, "--spec-draft-n-max").enumValues).toBeUndefined();
  });
});
