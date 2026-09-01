/**
 * Real-browser tests for the web UI.
 *
 * Everything else in the suite either stubs the DOM or checks the module graph
 * statically. That misses the class of bug those can't see: CSS that makes an
 * element unclickable, a script that throws on load, a dialog that won't close.
 * (The modal backdrop once covered the whole page because `display: flex` beat
 * the user agent's `[hidden] { display: none }` — invisible to every other
 * test here, obvious the moment a browser tries to click something.)
 *
 * Skipped unless LLAMACTL_E2E=1, so plain `bun test` stays fast and needs no
 * browser. Run with `bun run test:e2e` (after `bunx playwright install
 * chromium`). The control plane is a stub, so no daemon or model is involved.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import type { Model, RunningModel } from "../src/types.ts";
import { startWebServer, type WebServerHandle } from "../src/web/server.ts";
import { findFreePort } from "../src/net/ports.ts";

const ENABLED = process.env.LLAMACTL_E2E === "1";

/**
 * Poll until `fn` returns a truthy value, or throw. These run under `bun test`,
 * not Playwright's own runner, so its auto-retrying `expect` matchers are not
 * available — this covers the same need for the handful of places that await a
 * state change.
 */
async function until<T>(
  what: string,
  fn: () => T | Promise<T>,
  timeoutMs = 5000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (last: ${last})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

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
    repo: "acme/alpha",
    ...over,
  };
}

const RUNNING: RunningModel = {
  modelId: "gamma",
  name: "gamma",
  path: "/models/gamma.gguf",
  pid: 4242,
  port: 18000,
  status: "ready",
  startedAt: Date.now() - 120_000,
  restarts: 0,
  logPath: "/tmp/gamma.log",
  spec: { model: "gamma", ctxSize: 8192 },
  warnings: ["W no MTP head found; speculation disabled"],
};

/** Requests the stub control plane received, for asserting on mutations. */
const seen: { method: string; path: string; body: string }[] = [];

let upstream: ReturnType<typeof Bun.serve>;
let web: WebServerHandle;
let browser: Browser;
let page: Page;
/** Console errors and uncaught exceptions from the page. */
const pageErrors: string[] = [];

async function startStubControlPlane(): Promise<{ url: string; token: string }> {
  const port = await findFreePort(49950);
  const token = "stub-token";
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const body = req.method === "GET" ? "" : await req.text();
      seen.push({ method: req.method, path, body });

      switch (true) {
        case path === "/models":
          return Response.json({
            models: [
              model("alpha-q4", { repo: "acme/alpha" }),
              model("alpha-q8", { repo: "acme/alpha", quant: "Q8_0" }),
              model("beta", { repo: "beta/models" }),
              model("gamma", { repo: "beta/models" }),
              // Neither running nor favorited, so it stays in the catalog and
              // gives the repo grouping a second header to render.
              model("delta", { repo: "beta/models" }),
            ],
          });
        case path === "/ps":
          return Response.json({ running: [RUNNING] });
        case path === "/stats":
          return Response.json({
            stats: {
              ts: Date.now(),
              system: { cpuPct: 17, memUsed: 8e9, memTotal: 16e9, tempC: 45 },
              gpus: [
                { index: 0, name: "RTX", utilPct: 30, vramUsed: 4e9, vramTotal: 12e9, tempC: 55 },
              ],
              instances: [
                { modelId: "gamma", pid: 4242, cpuPct: 42, rssBytes: 2e9, vramBytes: 3e9 },
              ],
              gpuAvailable: true,
            },
            llamaServer: { path: "/usr/bin/llama-server", found: true, version: "b1234" },
          });
        case path === "/instances":
          if (req.method === "POST") return Response.json({ id: "new", name: "new" }, { status: 201 });
          return Response.json({
            instances: [
              {
                id: "alpha-long-ctx",
                name: "alpha-long-ctx",
                spec: { model: "alpha-q4", ctxSize: 32768, gpuLayers: 99 },
                createdAt: 0,
                updatedAt: 0,
              },
            ],
          });
        case path === "/favorites":
          return Response.json({ favorites: ["beta"] });
        case path.startsWith("/favorites/"):
          return Response.json({ favorites: [] });
        case path === "/downloads":
          return Response.json({ downloads: [] });
        case path === "/installs":
          return Response.json({ installs: [], builds: [], activeId: null });
        case path === "/llama/flags":
          return Response.json({
            spec: {
              version: "b1234",
              flags: [
                {
                  flag: "--rope-freq-base",
                  takesValue: true,
                  valueHint: "N",
                  help: "RoPE base frequency",
                  section: "generation",
                },
                { flag: "--verbose", takesValue: false, help: "verbose output" },
                // A single-choice enum: the editor must offer a <select>.
                {
                  flag: "--rope-scaling",
                  takesValue: true,
                  valueHint: "{none,linear,yarn}",
                  enumValues: ["none", "linear", "yarn"],
                  help: "RoPE frequency scaling method",
                },
                // The multi-value one that drives the MTP field.
                {
                  flag: "--spec-type",
                  takesValue: true,
                  valueHint: "none,draft-simple,draft-mtp",
                  enumValues: ["none", "draft-simple", "draft-mtp"],
                  multiple: true,
                  help: "comma-separated list of types of speculative decoding to use",
                },
                { flag: "--spec-draft-n-max", takesValue: true, valueHint: "N", default: "3",
                  help: "number of tokens to draft for speculative decoding" },
                { flag: "--spec-draft-n-min", takesValue: true, valueHint: "N", default: "0",
                  help: "minimum number of draft tokens" },
                { flag: "--spec-draft-ngl", takesValue: true, valueHint: "N", default: "auto",
                  help: "draft model layers to store in VRAM" },
                { flag: "--spec-draft-type-k", takesValue: true, valueHint: "TYPE", default: "f16",
                  enumValues: ["f32", "f16", "q8_0"], help: "KV cache type for K for the draft model" },
                { flag: "--spec-draft-p-min", takesValue: true, valueHint: "P", default: "0.00",
                  help: "minimum speculative decoding probability" },
                // NOTE: --spec-draft-type-v and --spec-draft-p-split are
                // deliberately absent, to prove unsupported flags are hidden.
                { flag: "--temp", takesValue: true, valueHint: "N", default: "0.80",
                  help: "temperature" },
                // llama.cpp packs an aside into the same parenthesis as the
                // value; the placeholder must show only the value.
                { flag: "--top-k", takesValue: true, valueHint: "N", default: "40, 0 = disabled",
                  help: "top-k sampling" },
                { flag: "--top-p", takesValue: true, valueHint: "N", default: "0.95",
                  help: "top-p sampling" },
                { flag: "--min-p", takesValue: true, valueHint: "N", default: "0.05",
                  help: "min-p sampling" },
                { flag: "--repeat-penalty", takesValue: true, valueHint: "N", default: "1.00",
                  help: "penalize repeat sequence of tokens" },
                { flag: "--repeat-last-n", takesValue: true, valueHint: "N", default: "64",
                  help: "last n tokens to consider for penalize" },
                { flag: "--presence-penalty", takesValue: true, valueHint: "N", default: "0.00",
                  help: "repeat alpha presence penalty" },
                { flag: "--frequency-penalty", takesValue: true, valueHint: "N", default: "0.00",
                  help: "repeat alpha frequency penalty" },
                { flag: "--seed", takesValue: true, valueHint: "SEED", default: "-1",
                  help: "RNG seed" },
              ],
            },
          });
        case path === "/start":
          return Response.json(RUNNING);
        case path === "/stop":
          return Response.json(RUNNING);
        default:
          return Response.json(
            { error: { code: "not_found", message: `no route ${path}` } },
            { status: 404 },
          );
      }
    },
  });
  return { url: `http://127.0.0.1:${port}`, token };
}

beforeAll(async () => {
  if (!ENABLED) return;
  const stub = await startStubControlPlane();
  web = await startWebServer({
    host: "127.0.0.1",
    port: await findFreePort(49960),
    token: null,
    connect: async () => ({ controlUrl: stub.url, token: stub.token, pid: process.pid }),
  });
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  await page.goto(web.url, { waitUntil: "networkidle" });
  // The first poll has to land before anything is on screen.
  await page.waitForSelector(".row", { timeout: 5000 });
});

afterAll(async () => {
  await browser?.close();
  web?.stop();
  upstream?.stop(true);
});

describe.skipIf(!ENABLED)("web UI in a browser", () => {
  test("loads without console errors or uncaught exceptions", () => {
    expect(pageErrors).toEqual([]);
  });

  test("renders the header meters from /stats", async () => {
    const header = await page.textContent("header");
    expect(header).toContain("cpu");
    expect(header).toContain("17%");
    expect(header).toContain("vram");
    expect(header).toContain("llama-server b1234");
  });

  test("renders the three sections with the running instance first", async () => {
    const titles = await page.$$eval(".section-title", (ns) => ns.map((n) => n.textContent.trim()));
    expect(titles[0]).toContain("Active instances");
    expect(titles.some((t) => t.includes("Favorites"))).toBe(true);
    expect(titles.some((t) => t.startsWith("Models"))).toBe(true);

    const first = await page.textContent(".row");
    expect(first).toContain("gamma");
    expect(first).toContain("ready");
    expect(first).toContain("⚠ 1"); // the startup warning is surfaced
  });

  test("groups the catalog by repo", async () => {
    const repos = await page.$$eval(".repo-header", (ns) => ns.map((n) => n.textContent.trim()));
    expect(repos).toEqual(["acme/alpha", "beta/models"]);
  });

  /**
   * The regression that motivated this file: Playwright refuses to click an
   * element another element covers, so a stray full-screen overlay fails here.
   */
  test("nothing overlays the page — toolbar buttons are actually clickable", async () => {
    // `click` fails if another element intercepts the pointer, which is exactly
    // what a stray full-screen backdrop does.
    await page.click("nav button[data-open='help']", { timeout: 2000 });
    expect(await page.locator("#modal-backdrop").isVisible()).toBe(true);
    await page.click("#modal .modal-head button", { timeout: 2000 }); // the ✕
    await until("the dialog to close", async () => page.locator("#modal-backdrop").isHidden());
    // A row action is reachable too, not just the toolbar.
    await page.locator(".row").first().hover({ timeout: 2000 });
    expect(await page.locator(".row button", { hasText: "info" }).first().isEnabled()).toBe(true);
  });

  test("Escape closes a dialog", async () => {
    await page.click("nav button[data-open='installs']", { timeout: 2000 });
    expect(await page.locator("#modal-backdrop").isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    await until("the dialog to close", async () => page.locator("#modal-backdrop").isHidden());
  });

  test("the filter narrows the catalog", async () => {
    await page.fill("#filter", "beta");
    await until("the catalog to narrow", async () => (await page.locator(".row").count()) === 1);
    await page.fill("#filter", "");
    await until("the catalog to return", async () => (await page.locator(".row").count()) > 1);
  });

  test("the info dialog shows metadata and the launch flags", async () => {
    await page.locator(".row", { hasText: "alpha-q4" }).getByText("info").click();
    const body = await page.textContent("#modal .modal-body");
    expect(body).toContain("llama");        // architecture
    expect(body).toContain("Q4_K_M");       // quant
    expect(body).toContain("--ctx-size 32768"); // from the saved profile
    await page.keyboard.press("Escape");
    await until("the dialog to close", async () => page.locator("#modal-backdrop").isHidden());
  });

  test("starting a model posts to /start", async () => {
    const before = seen.length;
    await page
      .locator(".row", { hasText: "beta" })
      .getByText("start", { exact: true })
      .click({ timeout: 2000 });
    const body = await until("the /start request", () =>
      seen.slice(before).find((r) => r.path === "/start")?.body,
    );
    expect(body).toContain('"model":"beta"');
  });

  test("the flag editor is a single scrollable list with grouped sections", async () => {
    await page
      .locator(".row", { hasText: "alpha-q8" })
      .getByText("+ profile")
      .click({ timeout: 2000 });
    await until("the editor to open", async () =>
      (await page.textContent("#modal"))?.includes("New profile"),
    );

    const sections = await page.$$eval(".editor-section", (ns) =>
      ns.map((n) => n.textContent.trim()),
    );
    expect(sections).toEqual([
      "Profile",
      "Context and memory",
      "Throughput",
      "Chat behaviour",
      "Speculative decoding",
      "Sampling defaults",
      "Multimodal",
      "Network",
      "Other llama-server flags",
    ]);

    // One field per line: every row starts at the same x, so nothing is laid
    // out in columns beside it.
    const lefts = await page.$$eval("#modal .field", (ns) =>
      ns.map((n) => Math.round(n.getBoundingClientRect().left)),
    );
    expect(new Set(lefts).size).toBe(1);

    // The list scrolls inside the dialog rather than growing the page.
    const scrolls = await page.$eval(
      "#modal .modal-body",
      (n) => n.scrollHeight > n.clientHeight,
    );
    expect(scrolls).toBe(true);
    // `document`/`window` aren't in this project's TS lib, so measure the page
    // through the viewport size rather than a bare global.
    const bodyHeight = await page.$eval("body", (n) => n.scrollHeight);
    expect(bodyHeight).toBeLessThanOrEqual(page.viewportSize()!.height);

    // The estimate and the buttons sit side by side, not stacked — a wrap here
    // would push the primary button below the fold of a full-height dialog.
    const [estimateBox, actionsBox] = await page.$$eval("#modal .modal-foot > *", (ns) =>
      ns.map((n) => {
        const r = n.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }),
    );
    expect(actionsBox!.left).toBeGreaterThanOrEqual(estimateBox!.right);
    expect(actionsBox!.top).toBeLessThan(estimateBox!.bottom);

    // The estimate is pinned in the footer, so scrolling the list can't hide it.
    expect(await page.locator(".modal-foot .estimate").isVisible()).toBe(true);
    await page.$eval("#modal .modal-body", (n) => {
      n.scrollTop = n.scrollHeight;
    });
    expect(await page.locator(".modal-foot .estimate").isVisible()).toBe(true);

    // A section heading is stuck to the top of the scrollport, and it covers
    // the body's top padding rather than leaving a strip for rows to show
    // through — so the topmost thing in the list is the heading, not a
    // half-scrolled field.
    // `$eval` hands the element in, so this needs no `document` global — which
    // this project's TS lib doesn't declare. Sticky offsets are measured from
    // the scrollport's *padding* edge, so that is what a stuck heading sits at.
    const stuck = await page.$eval("#modal .modal-body", (body) => {
      const view = body.ownerDocument.defaultView;
      const padTop = parseFloat(view.getComputedStyle(body).paddingTop) || 0;
      const top = body.getBoundingClientRect().top + padTop;
      const heads = [...body.querySelectorAll(".editor-section")].map((h) =>
        Math.abs(h.getBoundingClientRect().top - top),
      );
      return Math.min(...heads);
    });
    expect(stuck).toBeLessThanOrEqual(1);

    await page.keyboard.press("Escape");
    await until("the editor to close", async () => page.locator("#modal-backdrop").isHidden());
  });

  /**
   * Flags whose help names their choices get a picker instead of a text box,
   * driven purely by what the binary advertises — so a new enum flag in a
   * future llama.cpp build needs no code change here.
   */
  test("option-list flags render as pickers, and --spec-type as a multi-select", async () => {
    await page
      .locator(".row", { hasText: "alpha-q8" })
      .getByText("+ profile")
      .click({ timeout: 2000 });
    await until("the editor to open", async () =>
      (await page.textContent("#modal"))?.includes("New profile"),
    );

    // --spec-type is curated into the MTP section as tick boxes, one per type.
    const specRow = page.locator("#modal .field", { hasText: "Spec type" });
    const boxes = await specRow.locator(".check").allTextContents();
    expect(boxes.map((s) => s.trim())).toEqual(["none", "draft-simple", "draft-mtp"]);

    // ...and it is NOT also offered in the generic list, which would give one
    // flag two editors.
    await page.fill("#flag-search", "spec-type");
    expect(await page.locator("#modal .field", { hasText: "--spec-type" }).count()).toBe(1);

    // A single-choice enum from the same --help becomes a <select>.
    await page.fill("#flag-search", "rope-scaling");
    const scaling = page.locator("#modal .field", { hasText: "--rope-scaling" });
    expect(await scaling.locator("select").count()).toBe(1);
    expect((await scaling.locator("select option").allTextContents()).map((s) => s.trim())).toEqual([
      "(unset)",
      "none",
      "linear",
      "yarn",
    ]);

    // A plain metavar flag stays a text box.
    await page.fill("#flag-search", "rope-freq-base");
    const freq = page.locator("#modal .field", { hasText: "--rope-freq-base" });
    expect(await freq.locator("input[type='text']").count()).toBe(1);

    await page.keyboard.press("Escape");
    await until("the editor to close", async () => page.locator("#modal-backdrop").isHidden());
  });

  test("context size offers presets and still takes a typed value", async () => {
    await page
      .locator(".row", { hasText: "alpha-q8" })
      .getByText("+ profile")
      .click({ timeout: 2000 });
    await until("the editor to open", async () =>
      (await page.textContent("#modal"))?.includes("New profile"),
    );

    const ctx = page.locator("#modal .field:has(label:text-is('Ctx size'))");
    const options = (await ctx.locator("select option").allTextContents()).map((s) => s.trim());
    // The fixture model is trained to 32768, so bigger presets are not offered
    // and the model's own maximum is labelled.
    expect(options).toEqual([
      "Custom…",
      "2048 (2K)",
      "4096 (4K)",
      "8192 (8K)",
      "16384 (16K)",
      "32768 (32K) — model max",
    ]);

    // Picking a preset fills the box...
    await ctx.locator("select").selectOption("16384");
    expect(await ctx.locator("input").inputValue()).toBe("16384");

    // ...and typing an odd value is still allowed, flipping the picker to Custom.
    await ctx.locator("input").fill("12345");
    expect(await ctx.locator("select").inputValue()).toBe("custom");

    const before = seen.length;
    await page.click("#modal .modal-foot button.primary", { timeout: 2000 });
    const post = await until("the /instances POST", () =>
      seen.slice(before).find((r) => r.method === "POST" && r.path === "/instances"),
    );
    expect(post.body).toContain('"ctxSize":12345');
  });

  /**
   * These fields are passed through to llama-server verbatim, so offering one
   * the running binary doesn't accept would produce a launch that fails. Only
   * what `--help` advertises is shown, and the binary's own default is the
   * placeholder so an empty box reads as "llama-server's default".
   */
  test("raw flag fields track what the binary advertises", async () => {
    await page
      .locator(".row", { hasText: "alpha-q8" })
      .getByText("+ profile")
      .click({ timeout: 2000 });
    await until("the editor to open", async () =>
      (await page.textContent("#modal"))?.includes("New profile"),
    );

    // Exact label match: `hasText` is a substring test, so "Draft tokens"
    // would also match the "Min draft tokens" row.
    const row = (label: string) => page.locator(`#modal .field:has(label:text-is('${label}'))`);
    const labelled = async (label: string) => row(label).count();

    // Advertised → shown, with the default as the placeholder.
    expect(await labelled("Draft tokens")).toBe(1);
    expect(await row("Draft tokens").locator("input").getAttribute("placeholder")).toBe("3");
    // "40, 0 = disabled" is trimmed to the value alone.
    expect(await row("Top-k").locator("input").getAttribute("placeholder")).toBe("40");
    expect(await labelled("Draft cache K")).toBe(1);
    expect(await labelled("Temperature")).toBe(1);
    expect(await labelled("Repeat penalty")).toBe(1);

    // Not advertised by this binary → not offered at all.
    expect(await labelled("Draft cache V")).toBe(0);
    expect(await labelled("Split probability")).toBe(0);

    // An enum whose choices came from the help prose is a picker, not a box.
    expect(
      (await row("Draft cache K").locator("select option").allTextContents()).map((s) => s.trim()),
    ).toEqual(["(default)", "f32", "f16", "q8_0"]);

    await page.keyboard.press("Escape");
    await until("the editor to close", async () => page.locator("#modal-backdrop").isHidden());
  });

  test("sampling and speculative values are saved as raw flags", async () => {
    await page
      .locator(".row", { hasText: "alpha-q8" })
      .getByText("+ profile")
      .click({ timeout: 2000 });
    await until("the editor to open", async () =>
      (await page.textContent("#modal"))?.includes("New profile"),
    );

    await page.fill("#modal .field:has(label:text-is('Temperature')) input", "0.6");
    await page.fill("#modal .field:has(label:text-is('Top-k')) input", "20");
    await page.fill("#modal .field:has(label:text-is('Min-p')) input", "0.0");
    await page.fill("#modal .field:has(label:text-is('Draft tokens')) input", "2");
    await page.selectOption("#modal .field:has(label:text-is('Draft cache K')) select", "q8_0");

    const before = seen.length;
    await page.click("#modal .modal-foot button.primary", { timeout: 2000 });
    const post = await until("the /instances POST", () =>
      seen.slice(before).find((r) => r.method === "POST" && r.path === "/instances"),
    );
    expect(post.body).toContain('"--temp":"0.6"');
    expect(post.body).toContain('"--top-k":"20"');
    expect(post.body).toContain('"--min-p":"0.0"');
    expect(post.body).toContain('"--spec-draft-n-max":"2"');
    expect(post.body).toContain('"--spec-draft-type-k":"q8_0"');
    // Untouched fields stay out of the spec entirely, so llama-server's own
    // defaults apply rather than values the editor invented.
    expect(post.body).not.toContain("--top-p");
    expect(post.body).not.toContain("--seed");
  });

  test("ticking spec types saves them comma-joined where the supervisor reads them", async () => {
    await page
      .locator(".row", { hasText: "alpha-q8" })
      .getByText("+ profile")
      .click({ timeout: 2000 });
    await until("the editor to open", async () =>
      (await page.textContent("#modal"))?.includes("New profile"),
    );

    const specRow = page.locator("#modal .field", { hasText: "Spec type" });
    await specRow.locator(".check", { hasText: "draft-mtp" }).click();
    await specRow.locator(".check", { hasText: "draft-simple" }).click();

    const before = seen.length;
    await page.click("#modal .modal-foot button.primary", { timeout: 2000 });
    const post = await until("the /instances POST", () =>
      seen.slice(before).find((r) => r.method === "POST" && r.path === "/instances"),
    );
    // Ticked in the reverse order, but stored in the order the binary lists
    // them, and comma-joined into extraFlags — the exact spelling
    // src/supervisor/process.ts looks for when auto-filling an MTP head.
    expect(post.body).toContain('"--spec-type":"draft-simple,draft-mtp"');
  });

  test("the flag editor opens, estimates memory, and saves a profile", async () => {
    await page
      .locator(".row", { hasText: "alpha-q8" })
      .getByText("+ profile")
      .click({ timeout: 2000 });
    await until("the editor to open", async () =>
      (await page.textContent("#modal"))?.includes("New profile"),
    );
    // The live estimate comes from the shared estimateUsage over the GGUF dims.
    expect(await page.textContent(".estimate")).toContain("VRAM");

    await page.fill(".field:has(label:text-is('Ctx size')) input", "16384");
    // The binary's other flags are searchable and land in extraFlags.
    await page.fill("#flag-search", "rope");
    await page.fill(".field:has(label:text-is('--rope-freq-base')) input", "10000");

    const before = seen.length;
    await page.click("#modal .modal-foot button.primary", { timeout: 2000 });
    const post = await until("the /instances POST", () =>
      seen.slice(before).find((r) => r.method === "POST" && r.path === "/instances"),
    );
    expect(post.body).toContain('"ctxSize":16384');
    expect(post.body).toContain('"--rope-freq-base":"10000"');
  });

  test("no console errors accumulated across the whole session", () => {
    expect(pageErrors).toEqual([]);
  });
});
