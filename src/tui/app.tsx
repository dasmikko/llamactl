/**
 * The TUI root. Owns selection, modal mode, and the filter string; delegates
 * data + mutations to useDaemon and rendering to the presentational pieces.
 * Top-level useInput is gated by mode so modals own the keyboard while open.
 *
 * Exports runTui(config), the entry point index.ts dynamically imports.
 */

import React, { useEffect, useMemo, useState } from "react";
import { render, Box, Text, useApp, useInput, useStdout } from "ink";
import type {
  Config,
  Download,
  InstallsResponse,
  LaunchSpec,
  Model,
  StartRequest,
} from "../types.ts";
import { useDaemon } from "./useDaemon.ts";
import { buildRows, filterRows, defaultSpecForRow, type Row } from "./rows.ts";
import { parseRepo } from "../discovery/models.ts";
import { ResourceHeader } from "./ResourceHeader.tsx";
import { Table } from "./Table.tsx";
import { FlagEditor, type FlagEditorResult } from "./FlagEditor.tsx";
import { LogViewer } from "./LogViewer.tsx";
import { HelpOverlay } from "./HelpOverlay.tsx";
import { Filter } from "./Filter.tsx";
import { HfBrowser } from "./HfBrowser.tsx";
import { Downloads } from "./Downloads.tsx";
import { Installs } from "./Installs.tsx";
import { BuildForm } from "./BuildForm.tsx";
import { TextPrompt } from "./TextPrompt.tsx";
import { ModelInfo } from "./ModelInfo.tsx";
import { openInBrowser } from "./browser.ts";

type Mode =
  | "table"
  | "edit"
  | "logs"
  | "help"
  | "filter"
  | "hf"
  | "info"
  | "installs"
  | "build"
  | "buildlog"
  | "downloads"
  | "renameinstall";

/** Editor invocation context: are we creating a fresh profile or editing one? */
interface EditorState {
  title: string;
  initialName: string;
  initialSpec: LaunchSpec;
  /** Instance id to PUT, or null to POST a new instance. */
  instanceId: string | null;
  /** Explicit id to create under (the model's inline config); else derived. */
  createId?: string;
  /** Whether the editable Name field is shown (hidden for a model's inline config). */
  showName: boolean;
  /** The resolved model (when known) for the live memory estimate. */
  model: Model | undefined;
}

/** A destructive action armed and awaiting confirmation. */
type PendingAction =
  | { kind: "stop-instance"; id: string; label: string }
  | { kind: "delete-instance"; id: string; label: string }
  | { kind: "delete-model"; id: string; label: string }
  | { kind: "restart-daemon" }
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
    favorites,
    running,
    stats,
    llamaServer,
    downloads,
    installs,
    error,
    connected,
    connecting,
    start,
    stop,
    createInstance,
    updateInstance,
    removeInstance,
    toggleFavorite,
    deleteModel,
    searchHf,
    listHfFiles,
    pull,
    cancelDownload,
    dismissDownload,
    retryDownload,
    startBuild,
    cancelBuild,
    setActiveInstall,
    removeInstall,
    renameInstall,
    restartDaemon,
  } = daemon;

  const [mode, setMode] = useState<Mode>("table");
  // Selection is tracked by the row's unique key (not its index) so the cursor
  // follows a row when the list re-sorts — e.g. when a started model jumps to
  // the running group at the top.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  // The build log currently open in the buildlog view (path + title), or null.
  const [buildLog, setBuildLog] = useState<{ logPath: string; title: string } | null>(null);
  // The install being renamed (id + current name), or null.
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  // A pending destructive action awaiting confirmation (repeat the key or `y`).
  const [pending, setPending] = useState<PendingAction>(null);
  // A periodic "now" so uptime ticks even between data changes.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const allRows = useMemo(
    () => buildRows(models, instances, running, stats, favoriteSet),
    [models, instances, running, stats, favoriteSet],
  );
  const rows = useMemo(() => filterRows(allRows, filter), [allRows, filter]);
  // Split into three sections. buildRows sorts running → favorites → rest, so
  // `rows === [...runningRows, ...favoriteRows, ...modelRows]` stays contiguous,
  // which keeps the global selection index (selIdx) mapping into each section.
  const runningRows = useMemo(() => rows.filter((r) => r.running), [rows]);
  const favoriteRows = useMemo(
    () => rows.filter((r) => !r.running && r.isFavorite),
    [rows],
  );
  const modelRows = useMemo(
    () => rows.filter((r) => !r.running && !r.isFavorite),
    [rows],
  );

  // Resolve the tracked key to a current index, falling back to the top
  // when the tracked row is gone (or nothing is selected yet).
  const selIdx = useMemo(() => {
    if (selectedId === null) return 0;
    const i = rows.findIndex((r) => r.key === selectedId);
    return i >= 0 ? i : 0;
  }, [rows, selectedId]);

  const current: Row | undefined = rows[selIdx];

  // Keep the tracked key in sync (first selection, or when the row vanishes).
  useEffect(() => {
    if (current && current.key !== selectedId) setSelectedId(current.key);
  }, [current, selectedId]);

  /** Move the cursor to a row index, tracking it by key. */
  const moveTo = (i: number): void => {
    if (rows.length === 0) return;
    const clamped = Math.max(0, Math.min(i, rows.length - 1));
    setSelectedId(rows[clamped]!.key);
  };

  // Cancel any pending confirmation whenever the selection or mode changes.
  useEffect(() => {
    setPending(null);
  }, [selIdx, mode]);

  const openEditor = (row: Row, asNew: boolean): void => {
    const spec = defaultSpecForRow(row, config.defaultCtx, config.defaultGpuLayers);
    if (asNew) {
      // `n` → an additional profile (a testing variant) under this model. Blank
      // name so the store derives + auto-disambiguates the id from the model.
      setEditor({
        title: `New profile · ${row.name}`,
        initialName: "",
        initialSpec: { ...spec },
        instanceId: null,
        showName: true,
        model: row.model,
      });
    } else if (row.instance && row.isExtraProfile) {
      // `e` on an additional profile row → edit that profile (name editable).
      setEditor({
        title: `Edit profile · ${row.instance.name}`,
        initialName: row.instance.name,
        initialSpec: { ...row.instance.spec },
        instanceId: row.instance.id,
        showName: true,
        model: row.model,
      });
    } else if (row.instance) {
      // `e` on a model row that already has an inline config → edit it in place.
      // No name field: this is just the model's own flags.
      setEditor({
        title: `Edit flags · ${row.name}`,
        initialName: row.instance.name,
        initialSpec: { ...row.instance.spec },
        instanceId: row.instance.id,
        showName: false,
        model: row.model,
      });
    } else {
      // `e` on a model with no saved flags yet → create its inline config keyed
      // by the model id (so it merges onto the model row, not a child). No name.
      setEditor({
        title: `Edit flags · ${row.name}`,
        initialName: "",
        initialSpec: { ...spec },
        instanceId: null,
        createId: row.modelId,
        showName: false,
        model: row.model,
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
      void createInstance(result.name, result.spec, ed.createId);
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

      if (key.ctrl && input === "r") {
        // Ctrl+R: restart the daemon (requires confirmation) — a global action,
        // so it works whether or not a row is selected.
        if (pending?.kind === "restart-daemon") {
          void restartDaemon();
          setPending(null);
        } else {
          setPending({ kind: "restart-daemon" });
        }
        return;
      }

      if (input === "I") {
        // Capital I: open the managed-installs view (lowercase i is model info).
        setMode("installs");
        return;
      }
      if (input === "B") {
        // Capital B: open the build form to start a managed llama.cpp build.
        setMode("build");
        return;
      }
      if (input === "P") {
        // Capital P: manage downloads (lowercase p starts a pull).
        setMode("downloads");
        return;
      }

      if (!current) {
        if (input === "/") setMode("filter");
        else if (input === "p") setMode("hf");
        else if (input === "?") setMode("help");
        return;
      }

      if (key.return) {
        if (!current.running) onToggleRow(current);
        return;
      }
      if (key.ctrl && input === "s") {
        // Ctrl+S: stop a running instance (requires confirmation).
        if (current.running) {
          if (pending?.kind === "stop-instance") {
            void stop(pending.id);
            setPending(null);
          } else {
            setPending({ kind: "stop-instance", id: current.modelId, label: current.name });
          }
        }
        return;
      }
      if (input === "f") {
        void toggleFavorite(current.favoriteId);
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
        // Delete the model's file(s) from disk — only from a base model row
        // (not an additional profile row), and refused while it's running.
        if (pending?.kind === "delete-model") {
          void deleteModel(pending.id);
          setPending(null);
        } else if (current.model && !current.isExtraProfile && !current.running) {
          setPending({ kind: "delete-model", id: current.model.id, label: current.name });
        }
        return;
      }
      if (input === "y" && pending) {
        if (pending.kind === "stop-instance") void stop(pending.id);
        else if (pending.kind === "delete-instance") void removeInstance(pending.id);
        else if (pending.kind === "delete-model") void deleteModel(pending.id);
        else if (pending.kind === "restart-daemon") void restartDaemon();
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

  // How many catalog rows fit below everything else, so the MODELS list windows
  // and scrolls instead of overflowing the terminal. We subtract the height of
  // each fixed region by counting the lines it renders (the layout is all
  // single-line Text rows, so this stays in sync with the JSX below):
  //   header  = round border (2) + title/CPU/RAM (3) + 2 per GPU + warnings
  //   downloads = title (1) + up to 5 rows + marginBottom (1), only when shown
  //   active   = title (1) + column header (1) + rows (or 1 empty line)
  //   favorites = marginTop (1) + title (1) + column header (1) + rows, when shown
  //   models chrome = marginTop (1) + title (1) + column header (1)
  //   footer  = status bar (1)
  const gpuLines = gpuAvailable ? (stats?.gpus.length ?? 0) * 2 : 0;
  const headerLines =
    2 + 3 + gpuLines + (llamaServer && !llamaServer.found ? 1 : 0) + (error ? 1 : 0);
  const downloadsLines = downloads.length > 0 ? 1 + Math.min(5, downloads.length) + 1 : 0;
  const activeLines = 1 + 1 + Math.max(1, runningRows.length);
  const favoriteLines = favoriteRows.length > 0 ? 1 + 1 + 1 + favoriteRows.length : 0;
  const catalogCapacity = Math.max(
    1,
    screenRows - headerLines - downloadsLines - activeLines - favoriteLines - 3 - 1,
  );

  // Full-screen layout: fixed header, a growing body that fills the terminal,
  // and a footer pinned to the bottom row.
  return (
    <Box flexDirection="column" width={columns} height={screenRows}>
      <ResourceHeader
        stats={stats}
        llamaServer={llamaServer}
        error={error}
        connected={connected}
      />

      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        {mode === "edit" && editor ? (
          <FlagEditor
            title={editor.title}
            initialName={editor.initialName}
            showName={editor.showName}
            initialSpec={editor.initialSpec}
            onSubmit={onEditorSubmit}
            onCancel={onEditorCancel}
            // In edit mode the body holds only the editor (no footer), so the
            // header is all that sits above it.
            availableHeight={screenRows - headerLines}
            availableWidth={columns}
            model={editor.model}
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
        ) : mode === "buildlog" && buildLog ? (
          <LogViewer
            logPath={buildLog.logPath}
            title={buildLog.title}
            onClose={() => setMode("installs")}
          />
        ) : mode === "renameinstall" && renameTarget ? (
          <TextPrompt
            title={`Rename install "${renameTarget.id}"`}
            initialValue={renameTarget.name}
            onSubmit={(name) => {
              void renameInstall(renameTarget.id, name);
              setMode("installs");
            }}
            onCancel={() => setMode("installs")}
          />
        ) : mode === "installs" ? (
          <InstallsView
            installs={installs}
            width={columns}
            onSetActive={(id) => void setActiveInstall(id)}
            onCancelBuild={(id) => void cancelBuild(id)}
            onRemove={(id) => void removeInstall(id)}
            onViewLog={(logPath, title) => {
              setBuildLog({ logPath, title });
              setMode("buildlog");
            }}
            onRename={(id, name) => {
              setRenameTarget({ id, name });
              setMode("renameinstall");
            }}
            onBuild={() => setMode("build")}
            onClose={() => setMode("table")}
          />
        ) : mode === "build" ? (
          <BuildForm
            onSubmit={(req) => {
              void startBuild(req);
              setMode("installs");
            }}
            onCancel={() => setMode("table")}
          />
        ) : mode === "downloads" ? (
          <DownloadsView
            downloads={downloads}
            onCancel={(id) => void cancelDownload(id)}
            onDismiss={(id) => void dismissDownload(id)}
            onRetry={(id) => void retryDownload(id)}
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
            {favoriteRows.length > 0 ? (
              <Box marginTop={1}>
                <Table
                  title="★ FAVORITES"
                  titleColor="#ff8700"
                  variant="catalog"
                  rows={favoriteRows}
                  selectedIndex={
                    selIdx >= runningRows.length &&
                    selIdx < runningRows.length + favoriteRows.length
                      ? selIdx - runningRows.length
                      : -1
                  }
                  gpuAvailable={gpuAvailable}
                  now={now}
                  width={columns}
                />
              </Box>
            ) : null}
            <Box marginTop={1} flexGrow={1}>
              <Table
                title="MODELS"
                variant="catalog"
                rows={modelRows}
                selectedIndex={
                  selIdx >= runningRows.length + favoriteRows.length
                    ? selIdx - runningRows.length - favoriteRows.length
                    : -1
                }
                gpuAvailable={gpuAvailable}
                now={now}
                emptyText="(no models or profiles)"
                fill
                width={columns}
                maxRows={catalogCapacity}
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
    if (input === "h") {
      // Open the model's Hugging Face page. The repo is decoded from the file
      // path (the GGUF metadata is unreliable for this).
      const repo = row.model ? parseRepo(row.model.path) : null;
      if (repo) openInBrowser(`https://huggingface.co/${repo}`);
      return;
    }
    if (key.escape || input === "i" || input === "q") onClose();
  });
  return <ModelInfo row={row} now={now} />;
}

/**
 * Managed-installs modal: owns its own selection + Esc/key handling and renders
 * the presentational Installs list. Actions are delegated to useDaemon mutations
 * passed down from the app.
 */
/** Build statuses that are still running (cancelable). */
const BUILD_IN_FLIGHT = new Set<string>([
  "queued",
  "cloning",
  "configuring",
  "building",
  "installing",
]);

function InstallsView({
  installs,
  width,
  onSetActive,
  onCancelBuild,
  onRemove,
  onViewLog,
  onRename,
  onBuild,
  onClose,
}: {
  installs: InstallsResponse | null;
  width: number;
  onSetActive: (id: string | null) => void;
  onCancelBuild: (id: string) => void;
  onRemove: (id: string) => void;
  onViewLog: (logPath: string, title: string) => void;
  onRename: (id: string, name: string) => void;
  onBuild: () => void;
  onClose: () => void;
}): React.ReactElement {
  const list = installs?.installs ?? [];
  const builds = installs?.builds ?? [];
  const activeId = installs?.activeId ?? null;
  // Selection spans both lists: 0..list.length-1 select installs, the rest
  // select builds — so failed builds are reachable to view/remove.
  const total = list.length + builds.length;
  const [sel, setSel] = useState(0);
  const selIdx = total === 0 ? -1 : Math.min(sel, total - 1);
  const selInstall = selIdx >= 0 && selIdx < list.length ? list[selIdx] : undefined;
  const selBuild =
    selIdx >= list.length && selIdx < total ? builds[selIdx - list.length] : undefined;

  useInput((input, key) => {
    if (key.escape || input === "q" || input === "I") {
      onClose();
      return;
    }
    if (input === "B") {
      onBuild();
      return;
    }
    if (key.downArrow || input === "j") {
      setSel((i) => Math.min(i + 1, Math.max(0, total - 1)));
      return;
    }
    if (key.upArrow || input === "k") {
      setSel((i) => Math.max(0, i - 1));
      return;
    }
    if (key.return) {
      // Enter on an install toggles active (re-selecting active ⇒ PATH binary);
      // Enter on a build opens its log.
      if (selInstall) onSetActive(selInstall.id === activeId ? null : selInstall.id);
      else if (selBuild) onViewLog(selBuild.logPath, selBuild.name);
      return;
    }
    if ((input === "l" || input === "L") && selBuild) {
      onViewLog(selBuild.logPath, selBuild.name);
      return;
    }
    if (input === "r" && selInstall) {
      onRename(selInstall.id, selInstall.name);
      return;
    }
    if (input === "d") {
      // Remove the selected install, or dismiss the selected build (incl. failed).
      const id = selInstall?.id ?? selBuild?.id;
      if (id) onRemove(id);
      return;
    }
    if (input === "c" && selBuild && BUILD_IN_FLIGHT.has(selBuild.status)) {
      onCancelBuild(selBuild.id);
      return;
    }
  });

  return (
    <Installs
      installs={list}
      builds={builds}
      activeId={activeId}
      selectedIndex={selInstall ? selIdx : -1}
      selectedBuildIndex={selBuild ? selIdx - list.length : -1}
      width={width}
    />
  );
}

const DL_IN_FLIGHT = "downloading";

/**
 * Interactive downloads manager: navigate the download list, cancel an in-flight
 * download with `c`, and dismiss any entry (especially errored ones) with `d`.
 */
function DownloadsView({
  downloads,
  onCancel,
  onDismiss,
  onRetry,
  onClose,
}: {
  downloads: Download[];
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
  onRetry: (id: string) => void;
  onClose: () => void;
}): React.ReactElement {
  const [sel, setSel] = useState(0);
  const selIdx = downloads.length === 0 ? -1 : Math.min(sel, downloads.length - 1);
  const current = selIdx >= 0 ? downloads[selIdx] : undefined;

  useInput((input, key) => {
    if (key.escape || input === "q" || input === "P") {
      onClose();
      return;
    }
    if (key.downArrow || input === "j") {
      setSel((i) => Math.min(i + 1, Math.max(0, downloads.length - 1)));
      return;
    }
    if (key.upArrow || input === "k") {
      setSel((i) => Math.max(0, i - 1));
      return;
    }
    if (input === "c" && current && current.status === DL_IN_FLIGHT) {
      onCancel(current.id);
      return;
    }
    if (
      (input === "r" || key.return) &&
      current &&
      (current.status === "error" || current.status === "canceled")
    ) {
      onRetry(current.id);
      return;
    }
    if (input === "d" && current) {
      onDismiss(current.id);
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">
        MANAGE DOWNLOADS
      </Text>
      <Box marginTop={1} flexDirection="column">
        {downloads.length === 0 ? (
          <Text dimColor>(no downloads — press p to pull a model)</Text>
        ) : (
          <Downloads downloads={downloads} selectedIndex={selIdx} showHeader={false} />
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>j/k move · r retry/resume · c cancel · d dismiss · Esc close</Text>
      </Box>
    </Box>
  );
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
    if (pending.kind === "stop-instance") {
      return (
        <Box>
          <Text color="red">
            Stop "{pending.label}"? Press Ctrl+S or y to confirm, Esc to cancel.
          </Text>
        </Box>
      );
    }
    if (pending.kind === "restart-daemon") {
      return (
        <Box>
          <Text color="red">
            Restart the daemon? This stops all running instances. Press Ctrl+R or
            y to confirm, Esc to cancel.
          </Text>
        </Box>
      );
    }
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
     "Enter start · Ctrl+S stop · f fav · o open · i info · e edit · n new · d/D del · l logs · p pull · P downloads · I installs · B build · / filter · ? help · Ctrl+R restart · q quit";
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
