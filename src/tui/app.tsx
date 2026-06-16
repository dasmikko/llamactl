/**
 * The TUI root. Owns selection, modal mode, and the filter string; delegates
 * data + mutations to useDaemon and rendering to the presentational pieces.
 * The top-level keyboard handler is gated on table mode so modals own the
 * keyboard while open (each modal registers its own useKeyboard and is only
 * mounted while its mode is active).
 *
 * Exports runTui(config), the entry point index.ts dynamically imports.
 */

import {
  createSignal,
  createMemo,
  createEffect,
  onMount,
  onCleanup,
  Show,
  Switch,
  Match,
  type JSX,
} from "solid-js";
import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { TextAttributes } from "@opentui/core";
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
import { ShortcutBar, type Shortcut } from "./ShortcutBar.tsx";
import { openInBrowser } from "./browser.ts";
import { C } from "./theme.ts";

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

function App(props: AppProps): JSX.Element {
  const renderer = useRenderer();
  const quit = (): void => renderer.destroy();
  const dims = useTerminalDimensions();
  const columns = (): number => dims().width || 80;
  const screenRows = (): number => dims().height || 24;
  const daemon = useDaemon(props.config);
  const st = daemon.state;

  const [mode, setMode] = createSignal<Mode>("table");
  // Selection is tracked by the row's unique key (not its index) so the cursor
  // follows a row when the list re-sorts — e.g. when a started model jumps to
  // the running group at the top.
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [filter, setFilter] = createSignal("");
  const [editor, setEditor] = createSignal<EditorState | null>(null);
  // The build log currently open in the buildlog view (path + title), or null.
  const [buildLog, setBuildLog] = createSignal<{ logPath: string; title: string } | null>(null);
  // The install being renamed (id + current name), or null.
  const [renameTarget, setRenameTarget] = createSignal<{ id: string; name: string } | null>(null);
  // A pending destructive action awaiting confirmation (repeat the key or `y`).
  const [pending, setPending] = createSignal<PendingAction>(null);
  // A periodic "now" so uptime ticks even between data changes.
  const [now, setNow] = createSignal(Date.now());

  onMount(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(t));
  });

  const favoriteSet = createMemo(() => new Set(st.favorites));
  // Name of the active managed install (if any), shown in the header.
  const activeInstallName = createMemo<string | null>(() => {
    const id = st.installs?.activeId;
    if (!id) return null;
    return st.installs?.installs.find((i) => i.id === id)?.name ?? null;
  });
  const allRows = createMemo(() =>
    buildRows(st.models, st.instances, st.running, st.stats, favoriteSet()),
  );
  const rows = createMemo(() => filterRows(allRows(), filter()));
  // Split into three sections. buildRows sorts running → favorites → rest, so
  // `rows === [...runningRows, ...favoriteRows, ...modelRows]` stays contiguous,
  // which keeps the global selection index (selIdx) mapping into each section.
  const runningRows = createMemo(() => rows().filter((r) => r.running));
  const favoriteRows = createMemo(() => rows().filter((r) => !r.running && r.isFavorite));
  const modelRows = createMemo(() => rows().filter((r) => !r.running && !r.isFavorite));

  // Resolve the tracked key to a current index, falling back to the top
  // when the tracked row is gone (or nothing is selected yet).
  const selIdx = createMemo(() => {
    if (selectedId() === null) return 0;
    const i = rows().findIndex((r) => r.key === selectedId());
    return i >= 0 ? i : 0;
  });

  const current = createMemo<Row | undefined>(() => rows()[selIdx()]);

  // Keep the tracked key in sync (first selection, or when the row vanishes).
  createEffect(() => {
    const c = current();
    if (c && c.key !== selectedId()) setSelectedId(c.key);
  });

  /** Move the cursor to a row index, tracking it by key. */
  const moveTo = (i: number): void => {
    const rs = rows();
    if (rs.length === 0) return;
    const clamped = Math.max(0, Math.min(i, rs.length - 1));
    setSelectedId(rs[clamped]!.key);
  };

  // Cancel any pending confirmation whenever the selection or mode changes.
  createEffect(() => {
    selIdx();
    mode();
    setPending(null);
  });

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
      initialSpec: defaultSpecForRow(row, props.config.defaultCtx, props.config.defaultGpuLayers),
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
    const ed = editor();
    setEditor(null);
    setMode(ed?.returnMode ?? "table");
    if (!ed) return;
    if (ed.instanceId) {
      void daemon.updateInstance(ed.instanceId, { name: result.name, spec: result.spec });
    } else {
      void daemon.createInstance(result.name, result.spec);
      // The launch picker creates the profile and starts it in one step. Launch
      // by inline spec so we don't have to wait for the new id to round-trip.
      if (ed.launchAfter) void daemon.start({ spec: result.spec });
    }
  };

  const onEditorCancel = (): void => {
    const ret = editor()?.returnMode ?? "table";
    setEditor(null);
    setMode(ret);
  };

  // Top-level key handling, active only in table mode (modals own input then).
  useKeyboard((key) => {
    if (mode() !== "table") return;
    const ch = key.sequence;

    if (ch === "q" || (key.ctrl && key.name === "c")) {
      quit();
      return;
    }

    if (key.name === "down" || ch === "j") {
      moveTo(selIdx() + 1);
      return;
    }
    if (key.name === "up" || ch === "k") {
      moveTo(selIdx() - 1);
      return;
    }
    if (ch === "g") {
      moveTo(0);
      return;
    }
    if (ch === "G") {
      moveTo(rows().length - 1);
      return;
    }

    if (key.ctrl && key.name === "r") {
      // Ctrl+R: restart the daemon (requires confirmation) — a global action,
      // so it works whether or not a row is selected.
      if (pending()?.kind === "restart-daemon") {
        void daemon.restartDaemon();
        setPending(null);
      } else {
        setPending({ kind: "restart-daemon" });
      }
      return;
    }

    if (ch === "I") {
      // Capital I: open the managed-installs view (lowercase i is model info).
      setMode("installs");
      return;
    }
    if (ch === "B") {
      // Capital B: open the build form to start a managed llama.cpp build.
      setMode("build");
      return;
    }
    if (ch === "P") {
      // Capital P: manage downloads (lowercase p starts a pull).
      setMode("downloads");
      return;
    }

    const cur = current();
    if (!cur) {
      if (ch === "/") setMode("filter");
      else if (ch === "p") setMode("hf");
      else if (ch === "?") setMode("help");
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      // Enter on a model opens the launch picker (Default / a saved profile /
      // new). A running row is already up — Ctrl+S stops it.
      if (!cur.running) setMode("launch");
      return;
    }
    if (key.ctrl && key.name === "s") {
      // Ctrl+S: stop a running instance (requires confirmation).
      if (cur.running) {
        const p = pending();
        if (p?.kind === "stop-instance") {
          void daemon.stop(p.id);
          setPending(null);
        } else {
          setPending({ kind: "stop-instance", id: cur.modelId, label: cur.name });
        }
      }
      return;
    }
    if (ch === "f") {
      void daemon.toggleFavorite(cur.favoriteId);
      return;
    }
    if (ch === "e") {
      // `e` opens the profile manager (switch / create / edit / delete).
      setMode("profiles");
      return;
    }
    if (ch === "n") {
      // `n` jumps straight to creating a new profile for this model.
      openNewProfile(cur, { launchAfter: false, returnMode: "table" });
      return;
    }
    if (ch === "d") {
      // Delete a standalone (orphan) profile row. A discovered model's profiles
      // are deleted from inside the profile manager instead.
      const p = pending();
      if (p?.kind === "delete-instance") {
        void daemon.removeInstance(p.id);
        setPending(null);
      } else if (cur.instance) {
        setPending({ kind: "delete-instance", id: cur.instance.id, label: cur.instance.name });
      }
      return;
    }
    if (ch === "D") {
      // Delete the model's file(s) from disk — refused while it's running.
      const p = pending();
      if (p?.kind === "delete-model") {
        void daemon.deleteModel(p.id);
        setPending(null);
      } else if (cur.model && !cur.running) {
        setPending({ kind: "delete-model", id: cur.model.id, label: cur.name });
      }
      return;
    }
    if (ch === "y" && pending()) {
      const p = pending()!;
      if (p.kind === "stop-instance") void daemon.stop(p.id);
      else if (p.kind === "delete-instance") void daemon.removeInstance(p.id);
      else if (p.kind === "delete-model") void daemon.deleteModel(p.id);
      else if (p.kind === "restart-daemon") void daemon.restartDaemon();
      setPending(null);
      return;
    }
    if (key.name === "escape" && pending()) {
      setPending(null);
      return;
    }
    if (ch === "l") {
      if (cur.running) setMode("logs");
      return;
    }
    if (ch === "i") {
      setMode("info");
      return;
    }
    if (ch === "o") {
      // Open the running instance's llama-server web UI in the browser.
      if (cur.running) openInBrowser(`http://127.0.0.1:${cur.running.port}`);
      return;
    }
    if (ch === "/") {
      setMode("filter");
      return;
    }
    if (ch === "p") {
      setMode("hf");
      return;
    }
    if (ch === "?") {
      setMode("help");
      return;
    }
  });

  const gpuAvailable = (): boolean => st.stats?.gpuAvailable ?? false;
  const downloadingCount = (): number =>
    st.downloads.filter((d) => d.status === "downloading").length;

  // How many catalog rows fit below everything else, so the MODELS list windows
  // and scrolls instead of overflowing the terminal. Mirrors the fixed regions'
  // rendered line counts (see the JSX below).
  const headerLines = (): number => {
    const gaugeLines = 2 + (gpuAvailable() ? (st.stats?.gpus.length ?? 0) * 2 : 0);
    const daemonRows = st.daemon ? 6 + (downloadingCount() > 0 ? 1 : 0) : 0;
    return (
      2 +
      1 +
      Math.max(gaugeLines, daemonRows) +
      (st.llamaServer && !st.llamaServer.found ? 1 : 0) +
      (st.error ? 1 : 0)
    );
  };
  const catalogCapacity = (): number => {
    // Each section table is wrapped in a border (top line carries its title,
    // plus a bottom line) over a column header. So a section's non-row height is
    // border-top(1) + column-header(1) + border-bottom(1) = 3. Sections sit
    // directly adjacent (no margins). Downloads is borderless: title(1) + rows.
    const downloadsLines = st.downloads.length > 0 ? 1 + Math.min(5, st.downloads.length) : 0;
    const activeLines = 3 + Math.max(1, runningRows().length);
    const favoriteLines = favoriteRows().length > 0 ? 3 + favoriteRows().length : 0;
    // MODELS chrome = border-top(1) + column-header(1) + border-bottom(1) = 3.
    return Math.max(
      1,
      screenRows() - headerLines() - downloadsLines - activeLines - favoriteLines - 3 - 1,
    );
  };

  // The running instance's live memory, for the editor's "actual vs estimate".
  const editorActual = (): { rssBytes: number; vramBytes: number } | undefined => {
    const m = editor()?.model;
    const s = m ? st.stats?.instances.find((x) => x.modelId === m.id) : undefined;
    return s ? { rssBytes: s.rssBytes, vramBytes: s.vramBytes } : undefined;
  };

  return (
    <Show
      when={st.connected || st.connecting}
      fallback={<ConnectionError error={st.error} onQuit={quit} columns={columns()} rows={screenRows()} />}
    >
      {/* Full-screen layout: fixed header, a growing body that fills the
          terminal, and a footer pinned to the bottom row. The root background is
          painted every frame, so the whole screen repaints and no stale cells
          linger when the catalog windows/scrolls. */}
      <box flexDirection="column" width={columns()} height={screenRows()} backgroundColor={C.bg}>
        <ResourceHeader
          stats={st.stats}
          llamaServer={st.llamaServer}
          activeInstallName={activeInstallName()}
          error={st.error}
          connected={st.connected}
          daemon={st.daemon}
          now={now()}
          modelsCount={st.models.length}
          runningCount={st.running.length}
          profilesCount={st.instances.length}
          downloadingCount={downloadingCount()}
        />

        <box flexGrow={1} flexDirection="column" overflow="hidden">
          <Switch
            fallback={
              <>
                <Show when={st.downloads.length > 0}>
                  <Downloads downloads={st.downloads} />
                </Show>
                <Table
                  title="ACTIVE INSTANCES"
                  rows={runningRows()}
                  selectedIndex={selIdx() < runningRows().length ? selIdx() : -1}
                  gpuAvailable={gpuAvailable()}
                  now={now()}
                  emptyText="(none running)"
                  width={columns()}
                />
                <Show when={favoriteRows().length > 0}>
                  <Table
                    title="★ FAVORITES"
                    titleColor={C.favorite}
                    variant="catalog"
                    rows={favoriteRows()}
                    selectedIndex={
                      selIdx() >= runningRows().length &&
                      selIdx() < runningRows().length + favoriteRows().length
                        ? selIdx() - runningRows().length
                        : -1
                    }
                    gpuAvailable={gpuAvailable()}
                    now={now()}
                    width={columns()}
                  />
                </Show>
                <box flexGrow={1}>
                  <Table
                    title="MODELS"
                    variant="catalog"
                    grouped
                    rows={modelRows()}
                    selectedIndex={
                      selIdx() >= runningRows().length + favoriteRows().length
                        ? selIdx() - runningRows().length - favoriteRows().length
                        : -1
                    }
                    gpuAvailable={gpuAvailable()}
                    now={now()}
                    emptyText="(no models or profiles)"
                    fill
                    width={columns()}
                    maxRows={catalogCapacity()}
                  />
                </box>
              </>
            }
          >
            <Match when={mode() === "edit" && editor()}>
              <FlagEditor
                title={editor()!.title}
                initialName={editor()!.initialName}
                showName={editor()!.showName}
                initialSpec={editor()!.initialSpec}
                onSubmit={onEditorSubmit}
                onCancel={onEditorCancel}
                // In edit mode the body holds only the editor (no footer), so the
                // header is all that sits above it.
                availableHeight={screenRows() - headerLines()}
                availableWidth={columns()}
                model={editor()!.model}
                gpuAvailable={gpuAvailable()}
                actual={editorActual()}
                flagsSpec={st.llamaSpec ?? undefined}
              />
            </Match>
            <Match when={mode() === "logs" && current()?.running}>
              <LogViewer
                logPath={current()!.running!.logPath}
                title={current()!.name}
                onClose={() => setMode("table")}
              />
            </Match>
            <Match when={mode() === "help"}>
              <HelpView onClose={() => setMode("table")} />
            </Match>
            <Match when={mode() === "info" && current()}>
              <InfoView row={current()!} now={now()} onClose={() => setMode("table")} />
            </Match>
            <Match when={mode() === "hf"}>
              <HfBrowser
                columns={columns()}
                searchHf={daemon.searchHf}
                listHfFiles={daemon.listHfFiles}
                onPull={(repo, file) => void daemon.pull(repo, file)}
                onClose={() => setMode("table")}
              />
            </Match>
            <Match when={mode() === "buildlog" && buildLog()}>
              <LogViewer
                logPath={buildLog()!.logPath}
                title={buildLog()!.title}
                onClose={() => setMode("installs")}
              />
            </Match>
            <Match when={mode() === "renameinstall" && renameTarget()}>
              <TextPrompt
                columns={columns()}
                title={`Rename install "${renameTarget()!.id}"`}
                initialValue={renameTarget()!.name}
                onSubmit={(name) => {
                  void daemon.renameInstall(renameTarget()!.id, name);
                  setMode("installs");
                }}
                onCancel={() => setMode("installs")}
              />
            </Match>
            <Match when={mode() === "installs"}>
              <InstallsView
                installs={st.installs}
                width={columns()}
                onSetActive={(id) => void daemon.setActiveInstall(id)}
                onCancelBuild={(id) => void daemon.cancelBuild(id)}
                onRemove={(id) => void daemon.removeInstall(id)}
                onViewLog={(logPath, title) => {
                  setBuildLog({ logPath, title });
                  setMode("buildlog");
                }}
                onRename={(id, name) => {
                  setRenameTarget({ id, name });
                  setMode("renameinstall");
                }}
                onUpdate={(id) => void daemon.updateInstall(id)}
                onBuild={() => setMode("build")}
                onClose={() => setMode("table")}
              />
            </Match>
            <Match when={mode() === "build"}>
              <BuildForm
                columns={columns()}
                onSubmit={(req) => {
                  void daemon.startBuild(req);
                  setMode("installs");
                }}
                onCancel={() => setMode("table")}
              />
            </Match>
            <Match when={mode() === "downloads"}>
              <DownloadsView
                downloads={st.downloads}
                onCancel={(id) => void daemon.cancelDownload(id)}
                onDismiss={(id) => void daemon.dismissDownload(id)}
                onRetry={(id) => void daemon.retryDownload(id)}
                onClose={() => setMode("table")}
              />
            </Match>
          </Switch>
        </box>

        <Show when={mode() === "filter"}>
          <Filter
            columns={columns()}
            value={filter()}
            onChange={setFilter}
            onSubmit={() => setMode("table")}
            onCancel={() => {
              setFilter("");
              setMode("table");
            }}
          />
        </Show>
        <Show when={mode() === "table"}>
          <StatusBar filter={filter()} current={current()} />
        </Show>

        {/* Launch picker / profile manager: a centered modal floating over the
            catalog. It owns the keyboard while open (the app handler is gated to
            table mode), so ↑/↓/Enter/Esc go to the dialog. */}
        <Show when={(mode() === "launch" || mode() === "profiles") && current()}>
          <box
            position="absolute"
            width={columns()}
            height={screenRows()}
            justifyContent="center"
            alignItems="center"
          >
            <ProfileDialog
              variant={mode() === "launch" ? "launch" : "manage"}
              row={current()!}
              onLaunchProfile={(p) => {
                void daemon.start({ instance: p.id });
                setMode("table");
              }}
              onNew={() =>
                openNewProfile(current()!, {
                  launchAfter: mode() === "launch",
                  returnMode: mode() === "launch" ? "table" : "profiles",
                })
              }
              onEdit={(p) => openEditProfile(current()!, p)}
              onDelete={(p) => void daemon.removeInstance(p.id)}
              onClose={() => setMode("table")}
            />
          </box>
        </Show>

        {/* Confirmation overlay: an absolutely-positioned, screen-centered modal
            drawn on top of the normal UI so it's unmistakable. */}
        <Show when={pending()}>
          <box
            position="absolute"
            width={columns()}
            height={screenRows()}
            justifyContent="center"
            alignItems="center"
          >
            <ConfirmDialog action={pending()!} />
          </box>
        </Show>
      </box>
    </Show>
  );
}

/** Connection error screen: clear message + quit hint, never a crash. */
function ConnectionError(props: {
  error: string | null;
  onQuit: () => void;
  columns: number;
  rows: number;
}): JSX.Element {
  useKeyboard((key) => {
    if (key.sequence === "q" || (key.ctrl && key.name === "c")) props.onQuit();
  });
  return (
    <box flexDirection="column" width={props.columns} height={props.rows} padding={1} backgroundColor={C.bg}>
      <text fg={C.danger} attributes={TextAttributes.BOLD}>
        Could not connect to the llamactl daemon.
      </text>
      <Show when={props.error}>
        <text fg={C.danger}>{props.error}</text>
      </Show>
      <box marginTop={1}>
        <text fg={C.muted}>Press q to quit.</text>
      </box>
    </box>
  );
}

/** Help modal wrapper that owns its own Esc/? close handling. */
function HelpView(props: { onClose: () => void }): JSX.Element {
  useKeyboard((key) => {
    if (key.name === "escape" || key.sequence === "?" || key.sequence === "q") props.onClose();
  });
  return <HelpOverlay />;
}

/** Model-details modal wrapper that owns its own Esc/i close handling. */
function InfoView(props: { row: Row; now: number; onClose: () => void }): JSX.Element {
  useKeyboard((key) => {
    if (key.sequence === "h") {
      // Open the model's Hugging Face page. The repo is decoded from the file
      // path (the GGUF metadata is unreliable for this).
      const repo = props.row.model ? parseRepo(props.row.model.path) : null;
      if (repo) openInBrowser(`https://huggingface.co/${repo}`);
      return;
    }
    if (key.name === "escape" || key.sequence === "i" || key.sequence === "q") props.onClose();
  });
  return <ModelInfo row={props.row} now={props.now} />;
}

/** Build statuses that are still running (cancelable). */
const BUILD_IN_FLIGHT = new Set<string>([
  "queued",
  "cloning",
  "fetching",
  "configuring",
  "building",
  "installing",
]);

/**
 * Managed-installs modal: owns its own selection + Esc/key handling and renders
 * the presentational Installs list. Actions are delegated to useDaemon mutations
 * passed down from the app.
 */
function InstallsView(props: {
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
}): JSX.Element {
  const list = (): InstallsResponse["installs"] => props.installs?.installs ?? [];
  const builds = (): InstallsResponse["builds"] => props.installs?.builds ?? [];
  const activeId = (): string | null => props.installs?.activeId ?? null;
  // Selection spans both lists: 0..list.length-1 select installs, the rest
  // select builds — so failed builds are reachable to view/remove.
  const total = (): number => list().length + builds().length;
  const [sel, setSel] = createSignal(0);
  const selIdx = (): number => (total() === 0 ? -1 : Math.min(sel(), total() - 1));
  const selInstall = () => (selIdx() >= 0 && selIdx() < list().length ? list()[selIdx()] : undefined);
  const selBuild = () =>
    selIdx() >= list().length && selIdx() < total() ? builds()[selIdx() - list().length] : undefined;

  useKeyboard((key) => {
    const ch = key.sequence;
    if (key.name === "escape" || ch === "q" || ch === "I") {
      props.onClose();
      return;
    }
    if (ch === "n") {
      props.onBuild();
      return;
    }
    if (key.name === "down" || ch === "j") {
      setSel((i) => Math.min(i + 1, Math.max(0, total() - 1)));
      return;
    }
    if (key.name === "up" || ch === "k") {
      setSel((i) => Math.max(0, i - 1));
      return;
    }
    const inst = selInstall();
    const bld = selBuild();
    if (key.name === "return" || key.name === "enter") {
      // Enter on an install toggles active (re-selecting active ⇒ PATH binary);
      // Enter on a build opens its log.
      if (inst) props.onSetActive(inst.id === activeId() ? null : inst.id);
      else if (bld) props.onViewLog(bld.logPath, bld.name);
      return;
    }
    if ((ch === "l" || ch === "L") && bld) {
      props.onViewLog(bld.logPath, bld.name);
      return;
    }
    if (ch === "r" && inst) {
      props.onRename(inst.id, inst.name);
      return;
    }
    if (ch === "u" && inst) {
      props.onUpdate(inst.id);
      return;
    }
    if (ch === "d") {
      // Remove the selected install, or dismiss the selected build (incl. failed).
      const id = inst?.id ?? bld?.id;
      if (id) props.onRemove(id);
      return;
    }
    if (ch === "c" && bld && BUILD_IN_FLIGHT.has(bld.status)) {
      props.onCancelBuild(bld.id);
      return;
    }
  });

  // Context-aware footer: an install row exposes set-active/rename/update/remove;
  // a build row exposes view-log and (while in flight) cancel/dismiss.
  const shortcuts = (): Shortcut[] => {
    const items: Shortcut[] = [];
    const inst = selInstall();
    const bld = selBuild();
    if (total() > 0) items.push({ key: "↑↓", desc: "move" });
    if (inst) {
      items.push({ key: "Enter", desc: inst.id === activeId() ? "use PATH binary" : "set active" });
      items.push({ key: "r", desc: "rename" });
      items.push({ key: "u", desc: "update" });
      items.push({ key: "d", desc: "remove" });
    } else if (bld) {
      items.push({ key: "Enter", desc: "view log" });
      items.push({ key: "l", desc: "log" });
      if (BUILD_IN_FLIGHT.has(bld.status)) items.push({ key: "c", desc: "cancel" });
      items.push({ key: "d", desc: "dismiss" });
    }
    items.push({ key: "n", desc: "new" });
    items.push({ key: "Esc", desc: "close" });
    return items;
  };

  return (
    <Installs
      installs={list()}
      builds={builds()}
      activeId={activeId()}
      selectedIndex={selInstall() ? selIdx() : -1}
      selectedBuildIndex={selBuild() ? selIdx() - list().length : -1}
      width={props.width}
      shortcuts={shortcuts()}
    />
  );
}

const DL_IN_FLIGHT = "downloading";

/**
 * Interactive downloads manager: navigate the download list, cancel an in-flight
 * download with `c`, and dismiss any entry (especially errored ones) with `d`.
 */
function DownloadsView(props: {
  downloads: Download[];
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
  onRetry: (id: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [sel, setSel] = createSignal(0);
  const selIdx = (): number =>
    props.downloads.length === 0 ? -1 : Math.min(sel(), props.downloads.length - 1);
  const current = () => (selIdx() >= 0 ? props.downloads[selIdx()] : undefined);

  useKeyboard((key) => {
    const ch = key.sequence;
    if (key.name === "escape" || ch === "q" || ch === "P") {
      props.onClose();
      return;
    }
    if (key.name === "down" || ch === "j") {
      setSel((i) => Math.min(i + 1, Math.max(0, props.downloads.length - 1)));
      return;
    }
    if (key.name === "up" || ch === "k") {
      setSel((i) => Math.max(0, i - 1));
      return;
    }
    const cur = current();
    if (ch === "c" && cur && cur.status === DL_IN_FLIGHT) {
      props.onCancel(cur.id);
      return;
    }
    if (
      (ch === "r" || key.name === "return" || key.name === "enter") &&
      cur &&
      (cur.status === "error" || cur.status === "canceled")
    ) {
      props.onRetry(cur.id);
      return;
    }
    if (ch === "d" && cur) {
      props.onDismiss(cur.id);
      return;
    }
  });

  // Context-aware footer: cancel only an in-flight download, retry only a
  // failed/canceled one; dismiss any selected entry.
  const downloadShortcuts = (): Shortcut[] => {
    const items: Shortcut[] = [];
    const cur = current();
    if (props.downloads.length > 0) items.push({ key: "↑↓", desc: "move" });
    if (cur) {
      if (cur.status === DL_IN_FLIGHT) items.push({ key: "c", desc: "cancel" });
      if (cur.status === "error" || cur.status === "canceled") items.push({ key: "r", desc: "retry" });
      items.push({ key: "d", desc: "dismiss" });
    }
    items.push({ key: "Esc", desc: "close" });
    return items;
  };

  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={C.border} backgroundColor={C.surface} paddingX={1}>
      <text fg={C.accent} attributes={TextAttributes.BOLD}>
        MANAGE DOWNLOADS
      </text>
      <box marginTop={1} flexDirection="column">
        <Show
          when={props.downloads.length > 0}
          fallback={<text fg={C.text} attributes={TextAttributes.DIM}>(no downloads — press p to pull a model)</text>}
        >
          <Downloads downloads={props.downloads} selectedIndex={selIdx()} showHeader={false} />
        </Show>
      </box>
      <box marginTop={1}>
        <ShortcutBar items={downloadShortcuts()} />
      </box>
    </box>
  );
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

/**
 * Centered modal asking the user to confirm a destructive action. Uses the same
 * chrome as the other dialogs (rounded border + solid surface panel + a
 * ShortcutBar footer), with a danger accent on the frame and title to mark it as
 * destructive.
 */
function ConfirmDialog(props: { action: NonNullable<PendingAction> }): JSX.Element {
  const d = (): ReturnType<typeof describePending> => describePending(props.action);
  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={C.danger}
      backgroundColor={C.surface}
      paddingX={2}
      paddingY={1}
      minWidth={44}
    >
      <text fg={C.danger} attributes={TextAttributes.BOLD}>{`● ${d().title}`}</text>
      <box marginTop={1}>
        <text fg={C.text}>{d().message}</text>
      </box>
      <box marginTop={1}>
        <ShortcutBar
          items={[
            { key: `${d().confirmKey} / y`, desc: "confirm" },
            { key: "Esc", desc: "cancel" },
          ]}
        />
      </box>
    </box>
  );
}

interface StatusBarProps {
  filter: string;
  /** The selected row, so the bar lists only the shortcuts that currently apply. */
  current: Row | undefined;
}

/**
 * Context-aware footer: shows only the shortcuts usable for the current
 * selection (a running row exposes stop/logs/open; an idle one launch/profiles/
 * new), followed by the always-available global keys.
 */
function StatusBar(props: StatusBarProps): JSX.Element {
  const items = (): Shortcut[] => {
    const out: Shortcut[] = [];
    const current = props.current;
    if (current) {
      out.push({ key: "↑↓", desc: "move" });
      if (current.running) {
        out.push({ key: "Ctrl+S", desc: "stop" });
        out.push({ key: "l", desc: "logs" });
        out.push({ key: "o", desc: "open" });
      } else {
        out.push({ key: "Enter", desc: "launch" });
        out.push({ key: "e", desc: "profiles" });
        out.push({ key: "n", desc: "new" });
      }
      out.push({ key: "f", desc: current.isFavorite ? "unfav" : "fav" });
      out.push({ key: "i", desc: "info" });
      if (current.model && !current.running) out.push({ key: "D", desc: "delete" });
      else if (current.instance) out.push({ key: "d", desc: "delete" });
    }
    out.push({ key: "p", desc: "pull" });
    out.push({ key: "P", desc: "downloads" });
    out.push({ key: "I", desc: "installs" });
    out.push({ key: "/", desc: "filter" });
    out.push({ key: "?", desc: "help" });
    out.push({ key: "q", desc: "quit" });
    return out;
  };

  // The filter badge sits first so it stays visible even if the shortcut list
  // truncates on a narrow terminal.
  return (
    <box flexDirection="row">
      <Show when={props.filter}>
        <text fg={C.accent}>{`[filter: ${props.filter}]  `}</text>
      </Show>
      <ShortcutBar items={items()} />
    </box>
  );
}

/**
 * Connect to the daemon (autospawning), render the TUI full-screen on the
 * terminal's alternate screen buffer (opentui manages that), and resolve when
 * the user quits. The daemon keeps running after the UI exits.
 */
export async function runTui(config: Config): Promise<void> {
  await new Promise<void>((resolve) => {
    // opentui destroys the renderer on Ctrl+C / SIGINT itself; onDestroy fires
    // for that and for our explicit renderer.destroy() ('q'), letting us resolve.
    // Pin the renderer's base background to our theme so compositing never
    // depends on the terminal's OSC-detected background — that detection is
    // unreliable over SSH/tmux. (Text colors are likewise pinned per-<text>.)
    void render(() => <App config={config} />, {
      backgroundColor: C.bg,
      onDestroy: () => resolve(),
    } as never);
  });
}
