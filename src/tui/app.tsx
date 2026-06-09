/**
 * The TUI root. Owns selection, modal mode, and the filter string; delegates
 * data + mutations to useDaemon and rendering to the presentational pieces.
 * Top-level useInput is gated by mode so modals own the keyboard while open.
 *
 * Exports runTui(config), the entry point index.ts dynamically imports.
 */

import React, { useEffect, useMemo, useState } from "react";
import { render, Box, Text, useApp, useInput, useStdout } from "ink";
import type { Config, LaunchSpec, StartRequest } from "../types.ts";
import { useDaemon } from "./useDaemon.ts";
import { buildRows, filterRows, defaultSpecForRow, type Row } from "./rows.ts";
import { ResourceHeader } from "./ResourceHeader.tsx";
import { Table } from "./Table.tsx";
import { FlagEditor, type FlagEditorResult } from "./FlagEditor.tsx";
import { LogViewer } from "./LogViewer.tsx";
import { HelpOverlay } from "./HelpOverlay.tsx";
import { Filter } from "./Filter.tsx";
import { HfBrowser } from "./HfBrowser.tsx";
import { Downloads } from "./Downloads.tsx";
import { ModelInfo } from "./ModelInfo.tsx";
import { openInBrowser } from "./browser.ts";

type Mode = "table" | "edit" | "logs" | "help" | "filter" | "hf" | "info";

/** Editor invocation context: are we creating a fresh profile or editing one? */
interface EditorState {
  title: string;
  initialName: string;
  initialSpec: LaunchSpec;
  /** Instance id to PUT, or null to POST a new instance. */
  instanceId: string | null;
}

/** A destructive action armed and awaiting confirmation. */
type PendingAction =
  | { kind: "delete-instance"; id: string; label: string }
  | { kind: "delete-model"; id: string; label: string }
  | null;

interface AppProps {
  config: Config;
}

/** Track the terminal dimensions, updating on resize, so the UI fills the screen. */
function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout.columns || 80,
    rows: stdout.rows || 24,
  });
  useEffect(() => {
    const onResize = (): void =>
      setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}

function App({ config }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { columns, rows: screenRows } = useTerminalSize();
  const daemon = useDaemon(config);
  const {
    models,
    instances,
    running,
    stats,
    downloads,
    error,
    connected,
    connecting,
    start,
    stop,
    createInstance,
    updateInstance,
    removeInstance,
    deleteModel,
    searchHf,
    listHfFiles,
    pull,
  } = daemon;

  const [mode, setMode] = useState<Mode>("table");
  // Selection is tracked by the row's modelId (not its index) so the cursor
  // follows a row when the list re-sorts — e.g. when a started model jumps to
  // the running group at the top.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  // A pending destructive action awaiting confirmation (repeat the key or `y`).
  const [pending, setPending] = useState<PendingAction>(null);
  // A periodic "now" so uptime ticks even between data changes.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const allRows = useMemo(
    () => buildRows(models, instances, running, stats),
    [models, instances, running, stats],
  );
  const rows = useMemo(() => filterRows(allRows, filter), [allRows, filter]);
  // Split into the running ("active instances") group and everything else. The
  // row order is running-first, so `rows === [...runningRows, ...modelRows]`,
  // which keeps the global selection index (selIdx) mapping into each section.
  const runningRows = useMemo(() => rows.filter((r) => r.running), [rows]);
  const modelRows = useMemo(() => rows.filter((r) => !r.running), [rows]);

  // Resolve the tracked modelId to a current index, falling back to the top
  // when the tracked row is gone (or nothing is selected yet).
  const selIdx = useMemo(() => {
    if (selectedId === null) return 0;
    const i = rows.findIndex((r) => r.modelId === selectedId);
    return i >= 0 ? i : 0;
  }, [rows, selectedId]);

  const current: Row | undefined = rows[selIdx];

  // Keep the tracked id in sync (first selection, or when the row vanishes).
  useEffect(() => {
    if (current && current.modelId !== selectedId) setSelectedId(current.modelId);
  }, [current, selectedId]);

  /** Move the cursor to a row index, tracking it by modelId. */
  const moveTo = (i: number): void => {
    if (rows.length === 0) return;
    const clamped = Math.max(0, Math.min(i, rows.length - 1));
    setSelectedId(rows[clamped]!.modelId);
  };

  // Cancel any pending confirmation whenever the selection or mode changes.
  useEffect(() => {
    setPending(null);
  }, [selIdx, mode]);

  const openEditor = (row: Row, asNew: boolean): void => {
    const spec = defaultSpecForRow(row, config.defaultCtx, config.defaultGpuLayers);
    if (asNew) {
      setEditor({
        title: `New instance · ${row.name}`,
        initialName: "",
        initialSpec: { ...spec },
        instanceId: null,
      });
    } else if (row.instance) {
      setEditor({
        title: `Edit profile · ${row.instance.name}`,
        initialName: row.instance.name,
        initialSpec: { ...row.instance.spec },
        instanceId: row.instance.id,
      });
    } else {
      // No saved profile yet → editing creates one.
      setEditor({
        title: `New instance · ${row.name}`,
        initialName: row.name,
        initialSpec: { ...spec },
        instanceId: null,
      });
    }
    setMode("edit");
  };

  const onToggleRow = (row: Row): void => {
    if (row.running) {
      void stop(row.modelId);
      return;
    }
    let req: StartRequest;
    if (row.instance) {
      req = { instance: row.instance.id };
    } else {
      req = { model: row.model?.id ?? row.modelId };
    }
    void start(req);
  };

  const onEditorSubmit = (result: FlagEditorResult): void => {
    const ed = editor;
    setEditor(null);
    setMode("table");
    if (!ed) return;
    if (ed.instanceId) {
      void updateInstance(ed.instanceId, {
        name: result.name,
        spec: result.spec,
      });
    } else {
      void createInstance(result.name, result.spec);
    }
  };

  const onEditorCancel = (): void => {
    setEditor(null);
    setMode("table");
  };

  // Top-level key handling, active only in table mode (modals own input then).
  useInput(
    (input, key) => {
      if (input === "q" || (key.ctrl && input === "c")) {
        exit();
        return;
      }

      if (key.downArrow || input === "j") {
        moveTo(selIdx + 1);
        return;
      }
      if (key.upArrow || input === "k") {
        moveTo(selIdx - 1);
        return;
      }
      if (input === "g") {
        moveTo(0);
        return;
      }
      if (input === "G") {
        moveTo(rows.length - 1);
        return;
      }

      if (!current) {
        if (input === "/") setMode("filter");
        else if (input === "p") setMode("hf");
        else if (input === "?") setMode("help");
        return;
      }

      if (key.return) {
        onToggleRow(current);
        return;
      }
      if (input === "e") {
        openEditor(current, false);
        return;
      }
      if (input === "n") {
        openEditor(current, true);
        return;
      }
      if (input === "d") {
        if (pending?.kind === "delete-instance") {
          void removeInstance(pending.id);
          setPending(null);
        } else if (current.instance) {
          setPending({ kind: "delete-instance", id: current.instance.id, label: current.instance.name });
        }
        return;
      }
      if (input === "D") {
        // Delete the model's file(s) from disk — refused while it's running.
        if (pending?.kind === "delete-model") {
          void deleteModel(pending.id);
          setPending(null);
        } else if (current.model && !current.running) {
          setPending({ kind: "delete-model", id: current.model.id, label: current.name });
        }
        return;
      }
      if (input === "y" && pending) {
        if (pending.kind === "delete-instance") void removeInstance(pending.id);
        else void deleteModel(pending.id);
        setPending(null);
        return;
      }
      if (key.escape && pending) {
        setPending(null);
        return;
      }
      if (input === "l") {
        if (current.running) setMode("logs");
        return;
      }
      if (input === "i") {
        setMode("info");
        return;
      }
      if (input === "o") {
        // Open the running instance's llama-server web UI in the browser.
        if (current.running) openInBrowser(`http://127.0.0.1:${current.running.port}`);
        return;
      }
      if (input === "/") {
        setMode("filter");
        return;
      }
      if (input === "p") {
        setMode("hf");
        return;
      }
      if (input === "?") {
        setMode("help");
        return;
      }
    },
    { isActive: mode === "table" },
  );

  // Connection error screen: clear message + quit hint, never a crash.
  if (!connected && !connecting) {
    return (
      <Box flexDirection="column" width={columns} height={screenRows} padding={1}>
        <Text color="red" bold>
          Could not connect to the llamactl daemon.
        </Text>
        {error ? <Text color="red">{error}</Text> : null}
        <Box marginTop={1}>
          <Text dimColor>Press q to quit.</Text>
        </Box>
        <QuitOnly onQuit={exit} />
      </Box>
    );
  }

  const gpuAvailable = stats?.gpuAvailable ?? false;

  // Full-screen layout: fixed header, a growing body that fills the terminal,
  // and a footer pinned to the bottom row.
  return (
    <Box flexDirection="column" width={columns} height={screenRows}>
      <ResourceHeader stats={stats} error={error} connected={connected} />

      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        {mode === "edit" && editor ? (
          <FlagEditor
            title={editor.title}
            initialName={editor.initialName}
            initialSpec={editor.initialSpec}
            onSubmit={onEditorSubmit}
            onCancel={onEditorCancel}
          />
        ) : mode === "logs" && current?.running ? (
          <LogViewer
            logPath={current.running.logPath}
            title={current.name}
            onClose={() => setMode("table")}
          />
        ) : mode === "help" ? (
          <HelpView onClose={() => setMode("table")} />
        ) : mode === "info" && current ? (
          <InfoView row={current} now={now} onClose={() => setMode("table")} />
        ) : mode === "hf" ? (
          <HfBrowser
            searchHf={searchHf}
            listHfFiles={listHfFiles}
            onPull={(repo, file) => void pull(repo, file)}
            onClose={() => setMode("table")}
          />
        ) : (
          <>
            {downloads.length > 0 ? (
              <Box marginBottom={1}>
                <Downloads downloads={downloads} />
              </Box>
            ) : null}
            <Table
              title="ACTIVE INSTANCES"
              rows={runningRows}
              selectedIndex={selIdx < runningRows.length ? selIdx : -1}
              gpuAvailable={gpuAvailable}
              now={now}
              emptyText="(none running)"
              width={columns}
            />
            <Box marginTop={1} flexGrow={1}>
              <Table
                title="MODELS"
                variant="catalog"
                rows={modelRows}
                selectedIndex={selIdx >= runningRows.length ? selIdx - runningRows.length : -1}
                gpuAvailable={gpuAvailable}
                now={now}
                emptyText="(no models or profiles)"
                fill
                width={columns}
              />
            </Box>
          </>
        )}
      </Box>

      {mode === "filter" ? (
        <Filter
          value={filter}
          onChange={setFilter}
          onSubmit={() => setMode("table")}
          onCancel={() => {
            setFilter("");
            setMode("table");
          }}
        />
      ) : mode === "table" ? (
        <StatusBar pending={pending} filter={filter} />
      ) : null}
    </Box>
  );
}

/** Help modal wrapper that owns its own Esc/? close handling. */
function HelpView({ onClose }: { onClose: () => void }): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === "?" || input === "q") onClose();
  });
  return <HelpOverlay />;
}

/** Model-details modal wrapper that owns its own Esc/i close handling. */
function InfoView({
  row,
  now,
  onClose,
}: {
  row: Row;
  now: number;
  onClose: () => void;
}): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || input === "i" || input === "q") onClose();
  });
  return <ModelInfo row={row} now={now} />;
}

/** Minimal input handler used only on the connection-error screen. */
function QuitOnly({ onQuit }: { onQuit: () => void }): React.ReactElement {
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) onQuit();
  });
  return <Text> </Text>;
}

interface StatusBarProps {
  pending: PendingAction;
  filter: string;
}

function StatusBar({ pending, filter }: StatusBarProps): React.ReactElement {
  if (pending) {
    const what =
      pending.kind === "delete-instance"
        ? `profile "${pending.label}"`
        : `model "${pending.label}" FROM DISK`;
    const key = pending.kind === "delete-instance" ? "d" : "D";
    return (
      <Box>
        <Text color="red">
          Delete {what}? Press {key} or y to confirm, Esc to cancel.
        </Text>
      </Box>
    );
  }
  const hint =
    "Enter start/stop · o open · i info · e edit · n new · d/D del · l logs · p pull · / filter · ? help · q quit";
  return (
    <Box>
      <Text dimColor>{hint}</Text>
      {filter ? <Text color="cyan">{`  [filter: ${filter}]`}</Text> : null}
    </Box>
  );
}

/**
 * Connect to the daemon (autospawning), render the Ink app full-screen on the
 * terminal's alternate screen buffer, and resolve when the user quits. The
 * alternate buffer makes the UI take over the whole screen and restores the
 * prior terminal contents on exit. The daemon keeps running after the UI exits.
 */
export async function runTui(config: Config): Promise<void> {
  const ENTER_ALT_SCREEN = "\x1b[?1049h";
  const LEAVE_ALT_SCREEN = "\x1b[?1049l";
  const isTty = Boolean(process.stdout.isTTY);

  if (isTty) process.stdout.write(ENTER_ALT_SCREEN);
  // Keep Ink's built-in Ctrl+C so quitting works from every mode (the app's own
  // handler is inactive while a modal owns input).
  const { waitUntilExit } = render(<App config={config} />);
  try {
    await waitUntilExit();
  } catch {
    // Some exit paths (e.g. SIGINT) reject waitUntilExit; treat as a normal quit.
  } finally {
    if (isTty) process.stdout.write(LEAVE_ALT_SCREEN);
  }
}
