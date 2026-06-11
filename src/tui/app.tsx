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
  InstanceConfig,
  LaunchSpec,
  Model,
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
import { ProfileDialog } from "./ProfileDialog.tsx";
import { openInBrowser } from "./browser.ts";

type Mode =
  | "table"
  | "launch"
  | "profiles"
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
  /** Whether the editable Name field is shown. */
  showName: boolean;
  /** The resolved model (when known) for the live memory estimate. */
  model: Model | undefined;
  /** Mode to return to after submit/cancel (the table, or the profile manager). */
  returnMode: Mode;
  /** After creating, also launch the new spec immediately (the launch picker). */
  launchAfter?: boolean;
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
    updateInstall,
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
  // Name of the active managed install (if any), shown in the header.
  const activeInstallName = useMemo(() => {
    const id = installs?.activeId;
    if (!id) return null;
    return installs?.installs.find((i) => i.id === id)?.name ?? null;
  }, [installs]);
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

  // Open the flag editor to create a brand-new profile for `row`'s model. When
  // `launchAfter` is set (the launch picker's "+ New"), the new spec is also
  // started immediately. `returnMode` is where Esc/submit lands.
  const openNewProfile = (
    row: Row,
    opts: { launchAfter: boolean; returnMode: Mode },
  ): void => {
    setEditor({
      title: `New profile · ${row.name}`,
      initialName: "",
      initialSpec: defaultSpecForRow(row, config.defaultCtx, config.defaultGpuLayers),
      instanceId: null,
      showName: true,
      model: row.model,
      returnMode: opts.returnMode,
      launchAfter: opts.launchAfter,
    });
    setMode("edit");
  };

  // Open the flag editor on an existing profile (from the profile manager).
  const openEditProfile = (row: Row, profile: InstanceConfig): void => {
    setEditor({
      title: `Edit profile · ${profile.name}`,
      initialName: profile.name,
      initialSpec: { ...profile.spec },
      instanceId: profile.id,
      showName: true,
      model: row.model,
      returnMode: "profiles",
    });
    setMode("edit");
  };

  const onEditorSubmit = (result: FlagEditorResult): void => {
    const ed = editor;
    setEditor(null);
    setMode(ed?.returnMode ?? "table");
    if (!ed) return;
    if (ed.instanceId) {
      void updateInstance(ed.instanceId, { name: result.name, spec: result.spec });
    } else {
      void createInstance(result.name, result.spec);
      // The launch picker creates the profile and starts it in one step. Launch
      // by inline spec so we don't have to wait for the new id to round-trip.
      if (ed.launchAfter) void start({ spec: result.spec });
    }
  };

  const onEditorCancel = (): void => {
    const ret = editor?.returnMode ?? "table";
    setEditor(null);
    setMode(ret);
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
        // Enter on a model opens the launch picker (Default / a saved profile /
        // new). A running row is already up — Ctrl+S stops it.
        if (!current.running) setMode("launch");
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
        // `e` opens the profile manager (switch / create / edit / delete).
        setMode("profiles");
        return;
      }
      if (input === "n") {
        // `n` jumps straight to creating a new profile for this model.
        openNewProfile(current, { launchAfter: false, returnMode: "table" });
        return;
      }
      if (input === "d") {
        // Delete a standalone (orphan) profile row. A discovered model's profiles
        // are deleted from inside the profile manager instead.
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
        activeInstallName={activeInstallName}
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
            onUpdate={(id) => void updateInstall(id)}
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
                grouped
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
      ) : mode === "table" || mode === "launch" || mode === "profiles" ? (
        <StatusBar filter={filter} />
      ) : null}

      {/* Launch picker / profile manager: a centered modal floating over the
          catalog. It owns the keyboard while open (the app handler is gated to
          table mode), so ↑/↓/Enter/Esc go to the dialog. */}
      {(mode === "launch" || mode === "profiles") && current ? (
        <Box
          position="absolute"
          width={columns}
          height={screenRows}
          justifyContent="center"
          alignItems="center"
        >
          <ProfileDialog
            variant={mode === "launch" ? "launch" : "manage"}
            row={current}
            defaultCtx={config.defaultCtx}
            defaultGpuLayers={config.defaultGpuLayers}
            onLaunchDefault={() => {
              void start({
                model: current.instance?.spec.model ?? current.model?.id ?? current.modelId,
              });
              setMode("table");
            }}
            onLaunchProfile={(p) => {
              void start({ instance: p.id });
              setMode("table");
            }}
            onNew={() =>
              openNewProfile(current, {
                launchAfter: mode === "launch",
                returnMode: mode === "launch" ? "table" : "profiles",
              })
            }
            onEdit={(p) => openEditProfile(current, p)}
            onDelete={(p) => void removeInstance(p.id)}
            onClose={() => setMode("table")}
          />
        </Box>
      ) : null}

      {/* Confirmation overlay: an absolutely-positioned, screen-centered modal
          drawn on top of the normal UI so it's unmistakable. */}
      {pending ? (
        <Box
          position="absolute"
          width={columns}
          height={screenRows}
          justifyContent="center"
          alignItems="center"
        >
          <ConfirmDialog action={pending} />
        </Box>
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
  "fetching",
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
  onUpdate,
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
  onUpdate: (id: string) => void;
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
    if (input === "u" && selInstall) {
      onUpdate(selInstall.id);
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

/** Title / body / confirm-key for a pending confirmation. */
function describePending(action: NonNullable<PendingAction>): {
  title: string;
  message: string;
  /** The action-specific key that confirms (shown alongside `y`). */
  confirmKey: string;
} {
  switch (action.kind) {
    case "stop-instance":
      return {
        title: "Stop instance",
        message: `Stop "${action.label}"? This terminates the running llama-server.`,
        confirmKey: "Ctrl+S",
      };
    case "restart-daemon":
      return {
        title: "Restart daemon",
        message: "Restart the daemon? This stops ALL running instances.",
        confirmKey: "Ctrl+R",
      };
    case "delete-instance":
      return {
        title: "Delete profile",
        message: `Delete profile "${action.label}"?`,
        confirmKey: "d",
      };
    case "delete-model":
      return {
        title: "Delete model from disk",
        message: `Delete model "${action.label}" FROM DISK? This cannot be undone.`,
        confirmKey: "D",
      };
  }
}

/** A run of styled text inside a dialog row. */
interface Seg {
  text: string;
  color?: string;
  bold?: boolean;
}

const segLen = (segs: Seg[]): number => segs.reduce((n, s) => n + s.text.length, 0);

/**
 * Centered modal asking the user to confirm a destructive action.
 *
 * Ink's `<Box>` has no `backgroundColor`, and its own border is measured
 * separately from the background-filled rows — which left the border ragged
 * against the fill. So the entire panel (border included) is hand-drawn from
 * `<Text>` rows that all carry the same background, guaranteeing a clean,
 * solidly-filled rectangle. Every row is padded to a common inner width.
 */
function ConfirmDialog({ action }: { action: NonNullable<PendingAction> }): React.ReactElement {
  const d = describePending(action);
  // Explicit hex colors (truecolor) so the panel looks the same on every
  // terminal — ANSI "black" maps to a washed-out gray on many themes, which is
  // why a plain `backgroundColor:"black"` read as a low-contrast gray box.
  const BG = "#1b1e26"; // dark slate panel fill
  const BORDER = "#ff6b6b"; // red frame + danger accents
  const TEXT = "#eef1f6"; // primary message text
  const MUTED = "#9aa3b2"; // secondary / label text
  const CONFIRM = "#7ee787"; // confirm-key accent (green)
  const PAD = 2; // horizontal padding inside the border, each side

  // Title bar (danger glyph + bold red heading), body, and footer lines,
  // expressed as styled segments.
  const titleSegs: Seg[] = [
    { text: "● ", color: BORDER, bold: true },
    { text: d.title, color: BORDER, bold: true },
  ];
  const body: Seg[][] = [
    [{ text: d.message, color: TEXT }],
  ];
  const footer: Seg[] = [
    { text: `${d.confirmKey}`, color: CONFIRM, bold: true },
    { text: " / ", color: MUTED },
    { text: "y", color: CONFIRM, bold: true },
    { text: "  confirm", color: MUTED },
    { text: "     " },
    { text: "Esc", color: BORDER, bold: true },
    { text: "  cancel", color: MUTED },
  ];

  // Inner width = widest line (title, body, footer); the border spans that
  // plus the horizontal padding on each side.
  const inner = Math.max(
    segLen(titleSegs),
    ...body.map(segLen),
    segLen(footer),
  );
  const W = inner + PAD * 2;

  const horiz = "─".repeat(W);
  const pad = (n: number): React.ReactElement => (
    <Text backgroundColor={BG}>{" ".repeat(Math.max(0, n))}</Text>
  );

  // One interior row: left border, left pad, the segments, trailing fill so the
  // background reaches the right border, right pad, right border.
  const row = (segs: Seg[], key: string): React.ReactElement => (
    <Box key={key} flexDirection="row">
      <Text backgroundColor={BG} color={BORDER}>│</Text>
      {pad(PAD)}
      {segs.map((s, i) => (
        <Text key={i} backgroundColor={BG} color={s.color} bold={s.bold}>
          {s.text}
        </Text>
      ))}
      {pad(inner - segLen(segs))}
      {pad(PAD)}
      <Text backgroundColor={BG} color={BORDER}>│</Text>
    </Box>
  );

  return (
    <Box flexDirection="column">
      <Text backgroundColor={BG} color={BORDER}>{`╭${horiz}╮`}</Text>
      {row([], "pad-top")}
      {row(titleSegs, "title")}
      {row([], "gap-1")}
      {body.map((segs, i) => row(segs, `body-${i}`))}
      {row([], "gap-2")}
      {row(footer, "footer")}
      {row([], "pad-bottom")}
      <Text backgroundColor={BG} color={BORDER}>{`╰${horiz}╯`}</Text>
    </Box>
  );
}

interface StatusBarProps {
  filter: string;
}

function StatusBar({ filter }: StatusBarProps): React.ReactElement {
  const hint =
     "Enter launch · e profiles · n new · Ctrl+S stop · f fav · o open · i info · l logs · D del · p pull · P downloads · I installs · B build · / filter · ? help · Ctrl+R restart · q quit";
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
