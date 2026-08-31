/**
 * Headless render smoke tests for the opentui/Solid TUI components. They mount
 * each component in opentui's test renderer (no TTY) and assert expected text
 * lands in the captured frame — catching runtime render errors (e.g. the nested
 * <text> crash that emptied the model list) and the selection-highlight paths a
 * typecheck can't.
 */

import { test, expect } from "bun:test";
import { testRender } from "@opentui/solid";
import type { JSX } from "@opentui/solid";
import { ResourceHeader } from "../src/tui/ResourceHeader.tsx";
import { Table } from "../src/tui/Table.tsx";
import { Downloads } from "../src/tui/Downloads.tsx";
import { ModelInfo } from "../src/tui/ModelInfo.tsx";
import { HelpOverlay } from "../src/tui/HelpOverlay.tsx";
import { ProfileDialog } from "../src/tui/ProfileDialog.tsx";
import type { Row } from "../src/tui/rows.ts";
import type { StatsSnapshot, Download } from "../src/types.ts";

async function frameOf(node: () => JSX.Element): Promise<string> {
  const { captureCharFrame, renderOnce } = await testRender(node, { width: 110, height: 30 });
  await renderOnce();
  return captureCharFrame();
}

function mkRow(over: Partial<Row> = {}): Row {
  return {
    key: "m1",
    modelId: "m1",
    favoriteId: "m1",
    groupId: "org/repo",
    groupName: "Llama 3",
    name: "Llama-3-8B",
    quant: "Q4_K_M",
    repo: "org/repo",
    sizeBytes: 4_500_000_000,
    model: {
      id: "m1",
      name: "Llama-3-8B",
      path: "/models/llama3.gguf",
      arch: "llama",
      kind: "text",
      contextLength: 8192,
    } as never,
    profiles: [],
    instance: undefined,
    running: undefined,
    stats: undefined,
    isFavorite: false,
    ...over,
  };
}

const stats: StatsSnapshot = {
  system: { cpuPct: 42, memUsed: 8e9, memTotal: 16e9, tempC: 55 },
  gpuAvailable: true,
  gpus: [{ index: 0, name: "RTX", utilPct: 30, vramUsed: 4e9, vramTotal: 8e9, tempC: 60 }],
  instances: [],
} as unknown as StatsSnapshot;

test("ResourceHeader renders gauges + daemon facts", async () => {
  const frame = await frameOf(() => (
    <ResourceHeader
      stats={stats}
      llamaServer={{ found: true, version: "b1", path: "llama-server" } as never}
      activeInstallName="cuda"
      error={null}
      connected={true}
      daemon={{ pid: 1234, controlUrl: "http://127.0.0.1:48134", startedAt: Date.now() - 60000 }}
      now={Date.now()}
      modelsCount={11}
      runningCount={1}
      profilesCount={3}
      downloadingCount={0}
    />
  ));
  expect(frame).toContain("llamactl");
  expect(frame).toContain("CPU");
  expect(frame).toContain("connected");
  expect(frame).toContain("GPU0");
  expect(frame).toContain("PID");
});

test("Table grouped catalog renders unselected + selected rows", async () => {
  // Multiple rows with the selection on the first — exercises BOTH the selected
  // (inverse) and unselected (colored sibling <text>) paths, incl. the grouped
  // repo header. The unselected path is the one that previously crashed opentui.
  const rows = [mkRow(), mkRow({ key: "m2", modelId: "m2", name: "Mistral-7B" })];
  const frame = await frameOf(() => (
    <Table title="MODELS" variant="catalog" grouped rows={rows} selectedIndex={0} gpuAvailable={false} now={Date.now()} width={110} />
  ));
  expect(frame).toContain("MODELS");
  expect(frame).toContain("Llama-3-8B");
  expect(frame).toContain("Mistral-7B");
  expect(frame).toContain("org/repo"); // group header

  // All unselected — the exact case the model catalog hits.
  const unselected = await frameOf(() => (
    <Table title="MODELS" variant="catalog" grouped rows={rows} selectedIndex={-1} gpuAvailable={false} now={Date.now()} width={110} />
  ));
  expect(unselected).toContain("Llama-3-8B");
  expect(unselected).toContain("Mistral-7B");
});

test("Table empty section renders placeholder", async () => {
  const frame = await frameOf(() => (
    <Table title="ACTIVE INSTANCES" rows={[]} selectedIndex={-1} gpuAvailable={false} now={Date.now()} emptyText="(none running)" width={110} />
  ));
  expect(frame).toContain("ACTIVE INSTANCES");
  expect(frame).toContain("(none running)");
});

test("Downloads renders an in-flight entry", async () => {
  const dl: Download = {
    id: "d1",
    repo: "org/repo",
    file: "model.gguf",
    destPath: "/tmp/model.gguf",
    receivedBytes: 1e9,
    totalBytes: 4e9,
    status: "downloading" as never,
    error: null,
    startedAt: Date.now() - 5000,
  };
  const frame = await frameOf(() => <Downloads downloads={[dl]} />);
  expect(frame).toContain("org/repo");
  expect(frame).toContain("model.gguf");
});

test("ModelInfo renders model details", async () => {
  const frame = await frameOf(() => <ModelInfo row={mkRow()} now={Date.now()} />);
  expect(frame).toContain("Llama-3-8B");
});

test("ModelInfo shows every set spec field, including extraFlags", async () => {
  const row = mkRow({
    instance: {
      id: "p1",
      name: "fast",
      createdAt: 0,
      updatedAt: 0,
      spec: {
        model: "m1",
        ubatchSize: 512,
        parallel: 4,
        alias: "llama3",
        mlock: "on",
        mmap: "off",
        extraFlags: { "--spec-type": "draft-mtp", "--verbose": true },
      },
    } as never,
  });
  const frame = await frameOf(() => <ModelInfo row={row} now={Date.now()} />);
  expect(frame).toContain("--ubatch-size 512");
  expect(frame).toContain("--parallel 4");
  expect(frame).toContain("--alias llama3");
  expect(frame).toContain("--mlock");
  expect(frame).toContain("--no-mmap");
  expect(frame).toContain("--spec-type draft-mtp");
  expect(frame).toContain("--verbose");
});

test("ModelInfo surfaces startup warnings scraped from the log", async () => {
  const row = mkRow({
    running: {
      modelId: "m1",
      name: "Llama-3-8B",
      path: "/models/llama3.gguf",
      pid: 4242,
      port: 8080,
      status: "ready",
      startedAt: Date.now() - 10_000,
      restarts: 0,
      logPath: "/logs/x.log",
      spec: { model: "m1" },
      warnings: ["error: srv load_model: failed to create MTP context"],
    } as never,
  });
  const frame = await frameOf(() => <ModelInfo row={row} now={Date.now()} />);
  expect(frame).toContain("Startup warnings");
  expect(frame).toContain("failed to create MTP context");
});

test("HelpOverlay renders", async () => {
  const frame = await frameOf(() => <HelpOverlay />);
  expect(frame.toLowerCase()).toContain("help");
});

test("ProfileDialog launch picker renders", async () => {
  const frame = await frameOf(() => (
    <ProfileDialog
      variant="launch"
      row={mkRow()}
      onLaunchProfile={() => {}}
      onNew={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
      onClose={() => {}}
    />
  ));
  expect(frame).toContain("Llama-3-8B");
});
