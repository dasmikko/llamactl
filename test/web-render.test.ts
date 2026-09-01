/**
 * Executes the real browser modules against a stub DOM.
 *
 * The front end is plain ES modules served as text, so nothing else in the
 * suite actually *runs* it. This does: the sources are written to a temp dir
 * with their `/mod/...` specifiers pointed at the real TypeScript they are
 * transpiled from (Bun imports `.ts` directly), then imported and rendered.
 * A broken render — a bad property name, a helper that doesn't exist, a row
 * join that drops models — fails here rather than in the browser.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { InstanceConfig, Model, RunningModel, StatsSnapshot } from "../src/types.ts";
import { ASSETS } from "../src/web/assets.ts";
import { specToArgs } from "../src/instances/spec.ts";
import { FakeElement, installFakeDom, type FakeDom } from "./helpers/fake-dom.ts";

const SRC = join(import.meta.dir, "..", "src");

/** `/mod/...` URLs → the project source they are transpiled from. */
const MOD_SOURCES: Record<string, string> = {
  "/mod/tui/rows.js": join(SRC, "tui", "rows.ts"),
  "/mod/instances/spec.js": join(SRC, "instances", "spec.ts"),
  "/mod/instances/estimate.js": join(SRC, "instances", "estimate.ts"),
  "/mod/errors.js": join(SRC, "errors.ts"),
};

let dir: string;
let dom: FakeDom;
// Loaded browser modules. They are untyped browser JavaScript imported at
// runtime from a temp dir, so `any` is the only shape available here — what
// they return is asserted below rather than declared.
let catalog: any;
let info: any;
let store: any;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "llamactl-render-"));
  for (const [path, asset] of ASSETS) {
    if (!path.endsWith(".js")) continue;
    const dest = join(dir, path.slice(1));
    await mkdir(dirname(dest), { recursive: true });
    let src = asset.body;
    for (const [url, real] of Object.entries(MOD_SOURCES)) {
      src = src.replaceAll(`"${url}"`, JSON.stringify(real));
    }
    await writeFile(dest, src);
  }
  dom = installFakeDom();
  catalog = await import(join(dir, "views", "catalog.js"));
  info = await import(join(dir, "views", "info.js"));
  store = await import(join(dir, "lib", "store.js"));
});

afterAll(async () => {
  dom?.restore();
  await rm(dir, { recursive: true, force: true });
});

function model(id: string, over: Partial<Model> = {}): Model {
  return {
    id,
    name: id,
    path: `/models/${id}.gguf`,
    sizeBytes: 4_000_000_000,
    quant: "Q4_K_M",
    source: "config",
    mtimeMs: 0,
    arch: "llama",
    contextLength: 32768,
    nLayers: 32,
    kvDim: 1024,
    nEmbd: 4096,
    nHeads: 32,
    nextnLayers: null,
    kind: "text",
    org: "acme",
    repo: "acme/models",
    ...over,
  };
}

function running(id: string): RunningModel {
  return {
    modelId: id,
    name: id,
    path: `/models/${id}.gguf`,
    pid: 4242,
    port: 18000,
    status: "ready",
    startedAt: Date.now() - 65_000,
    restarts: 0,
    logPath: "/tmp/x.log",
    spec: { model: id },
    warnings: ["W missing MTP head"],
  };
}

function profile(id: string, modelId: string): InstanceConfig {
  return {
    id,
    name: id,
    spec: { model: modelId, ctxSize: 8192 },
    createdAt: 0,
    updatedAt: 0,
  };
}

const stats: StatsSnapshot = {
  ts: 0,
  system: { cpuPct: 12, memUsed: 1, memTotal: 2, tempC: 40 },
  gpus: [],
  instances: [{ modelId: "alpha", pid: 4242, cpuPct: 55, rssBytes: 1024, vramBytes: 0 }],
  gpuAvailable: false,
};

/** Point the store at fixture data and render into a fresh container. */
function render(over: Record<string, unknown> = {}): FakeElement {
  Object.assign(store.state, {
    models: [],
    instances: [],
    favorites: [],
    running: [],
    stats,
    downloads: [],
    installs: null,
    llamaSpec: null,
    error: null,
    loaded: true,
    ...over,
  });
  const container = new FakeElement("main");
  catalog.setFilter("");
  catalog.renderCatalog(container);
  return container;
}

describe("catalog render", () => {
  test("renders the three sections with running instances first", () => {
    const container = render({
      models: [model("alpha"), model("beta")],
      running: [running("alpha")],
      favorites: ["beta"],
    });
    const text = container.lines().join("\n");
    expect(text).toContain("Active instances");
    expect(text).toContain("★ Favorites");
    expect(text).toContain("Models");

    const rows = container.byClass("row");
    expect(rows).toHaveLength(2);
    // Running first, favorite second — the TUI's ordering.
    expect(rows[0]!.dataset.key).toBe("m:alpha");
    expect(rows[1]!.dataset.key).toBe("m:beta");
    expect(rows[0]!.className).toContain("is-running");
  });

  test("a running row shows status, port, live stats and its warning count", () => {
    const container = render({ models: [model("alpha")], running: [running("alpha")] });
    const text = container.byClass("row")[0]!.textContent;
    expect(text).toContain("ready");
    expect(text).toContain(":18000");
    expect(text).toContain("55%");
    expect(text).toContain("⚠ 1");
    const labels = container.byTag("button").map((b) => b.textContent);
    expect(labels).toContain("stop");
    expect(labels).toContain("chat");
    expect(labels).toContain("logs");
    expect(labels).not.toContain("start");
  });

  test("an idle model offers start, and start ▾ once it has profiles", () => {
    const plain = render({ models: [model("alpha")] });
    expect(plain.byTag("button").map((b) => b.textContent)).toContain("start");

    const withProfile = render({
      models: [model("alpha")],
      instances: [profile("fast", "alpha")],
    });
    const labels = withProfile.byTag("button").map((b) => b.textContent);
    expect(labels).toContain("start ▾");
    expect(labels).toContain("profiles (1)");
  });

  test("the catalog groups by repo with one header per repo", () => {
    const container = render({
      models: [
        model("a1", { repo: "acme/one" }),
        model("a2", { repo: "acme/one" }),
        model("b1", { repo: "beta/two" }),
      ],
    });
    const headers = container.byClass("repo-header").map((h) => h.textContent);
    expect(headers).toEqual(["acme/one", "beta/two"]);
    // Variants sit under their header, indented.
    expect(container.byClass("row").every((r) => r.className.includes("indent"))).toBe(true);
  });

  test("the filter narrows the list the way the TUI's does", () => {
    Object.assign(store.state, {
      models: [model("alpha"), model("beta")],
      instances: [],
      favorites: [],
      running: [],
      stats,
      loaded: true,
    });
    catalog.setFilter("bet");
    const container = new FakeElement("main");
    catalog.renderCatalog(container);
    expect(container.byClass("row")).toHaveLength(1);
    expect(container.byClass("row")[0]!.dataset.key).toBe("m:beta");
    catalog.setFilter("");
  });

  test("an empty catalog says so instead of rendering nothing", () => {
    const container = render();
    const text = container.lines().join("\n");
    expect(text).toContain("(none running)");
    expect(text).toContain("(no models or profiles match)");
  });

  test("a favorited model is starred and floats above the catalog", () => {
    const container = render({ models: [model("alpha")], favorites: ["alpha"] });
    const star = container.byClass("star")[0]!;
    expect(star.textContent).toBe("★");
    expect(star.className).toContain("on");
  });
});

describe("spec rendering matches the daemon's argv", () => {
  /**
   * `specLines` (info.js) is a hand-written mirror of `specToArgs`. If they
   * drift, the details panel lies about what the child is launched with — so
   * assert every flag the daemon would emit shows up in the panel.
   */
  test("every flag specToArgs emits appears in the info panel", () => {
    const spec = {
      model: "alpha",
      ctxSize: 8192,
      gpuLayers: 30,
      nCpuMoe: 4,
      threads: 8,
      batchSize: 2048,
      ubatchSize: 512,
      parallel: 2,
      alias: "my-model",
      mmproj: "/models/mmproj.gguf",
      specDraftModel: "/models/mtp.gguf",
      mlock: "on" as const,
      mmap: "off" as const,
      flashAttn: "on" as const,
      reasoning: "off" as const,
      jinja: "on" as const,
      chatTemplate: "chatml",
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
      host: "127.0.0.1",
      port: 9999,
      extraFlags: { "--rope-freq-base": "10000" },
      extraArgs: ["--verbose"],
    };
    const argv = specToArgs({
      modelPath: "/models/alpha.gguf",
      port: 9999,
      spec,
      configArgs: [],
    });
    const shown = info.specLines(spec).join(" ");

    for (const arg of argv) {
      // --model and the resolved path are shown as separate metadata fields.
      if (arg === "--model" || arg === "/models/alpha.gguf") continue;
      if (!arg.startsWith("-")) continue;
      expect(`${arg} in panel: ${shown.includes(arg)}`).toBe(`${arg} in panel: true`);
    }
  });

  test("an empty spec renders as (defaults)", () => {
    expect(info.specLines({ model: "alpha" })).toEqual(["(defaults)"]);
  });

  test("a curated flag smuggled into extraFlags is hidden, as specToArgs skips it", () => {
    expect(info.specLines({ model: "a", extraFlags: { "--ctx-size": "1" } })).toEqual([
      "(defaults)",
    ]);
  });
});

describe("style guards", () => {
  test("hidden-toggled elements with a display rule keep a [hidden] override", () => {
    // `display: flex` outranks the user agent's `[hidden] { display: none }`,
    // which once left the modal backdrop covering the page and swallowing every
    // click. Any such element needs an explicit override.
    const css = ASSETS.get("/style.css")!.body;
    const html = ASSETS.get("/index.html")!.body;
    for (const m of html.matchAll(/id="([a-z-]+)"[^>]*\shidden/g)) {
      const id = m[1]!;
      const rule = new RegExp(`#${id}\\s*\\{[^}]*display:`);
      if (!rule.test(css)) continue; // no display rule ⇒ `hidden` works as-is
      const guard = new RegExp(`#${id}\\[hidden\\]\\s*\\{[^}]*display:\\s*none`);
      expect(`#${id} has a [hidden] guard: ${guard.test(css)}`).toBe(
        `#${id} has a [hidden] guard: true`,
      );
    }
  });
});
