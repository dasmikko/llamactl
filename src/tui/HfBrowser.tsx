/**
 * Hugging Face browse-and-pull modal. Three stages: a search box, a list of
 * matching repos, and a list of the repo's GGUF files. Picking a file kicks off
 * a download (tracked in the Downloads section) and closes the modal. Esc steps
 * back a stage, then closes. Hand-rolled input via useKeyboard — no extra deps.
 */

import { createSignal, Show, For, type JSX } from "solid-js";
import { TextAttributes } from "@opentui/core";
import type { HfRepo, HfFile } from "../types.ts";
import { humanBytes } from "./format.ts";
import { ShortcutBar, type Shortcut } from "./ShortcutBar.tsx";
import { useKeyboard } from "@opentui/solid";
import { editText, CursorText, type TextEdit } from "./textinput.tsx";
import { C } from "./theme.ts";

type Stage = "search" | "results" | "files";

/** Max rows shown per list; the view scrolls to keep the selection visible. */
const MAX_ROWS = 14;

/** Return the visible slice and its start index so `selected` stays on-screen. */
function windowed<T>(items: T[], selected: number): { slice: T[]; start: number } {
  if (items.length <= MAX_ROWS) return { slice: items, start: 0 };
  let start = selected - Math.floor(MAX_ROWS / 2);
  start = Math.max(0, Math.min(start, items.length - MAX_ROWS));
  return { slice: items.slice(start, start + MAX_ROWS), start };
}

export interface HfBrowserProps {
  searchHf: (query: string) => Promise<HfRepo[]>;
  listHfFiles: (repo: string) => Promise<HfFile[]>;
  onPull: (repo: string, file: string) => void;
  onClose: () => void;
  /** Terminal width, used to bound the search input so it scrolls, not wraps. */
  columns: number;
}

export function HfBrowser(props: HfBrowserProps): JSX.Element {
  const [stage, setStage] = createSignal<Stage>("search");
  const [search, setSearch] = createSignal<TextEdit>({ value: "", cursor: 0 });
  const [repos, setRepos] = createSignal<HfRepo[]>([]);
  const [repoIdx, setRepoIdx] = createSignal(0);
  const [repo, setRepo] = createSignal("");
  const [files, setFiles] = createSignal<HfFile[]>([]);
  const [fileIdx, setFileIdx] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  const runSearch = async (): Promise<void> => {
    const query = search().value.trim();
    if (query === "") return;
    setBusy(true);
    setErr(null);
    try {
      const r = await props.searchHf(query);
      setRepos(r);
      setRepoIdx(0);
      setStage("results");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openRepo = async (id: string): Promise<void> => {
    setBusy(true);
    setErr(null);
    setRepo(id);
    try {
      const f = await props.listHfFiles(id);
      setFiles(f);
      setFileIdx(0);
      setStage("files");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useKeyboard((key) => {
    if (busy()) return; // ignore keys while a request is in flight

    if (key.name === "escape") {
      if (stage() === "files") setStage("results");
      else if (stage() === "results") setStage("search");
      else props.onClose();
      return;
    }

    if (stage() === "search") {
      if (key.name === "return" || key.name === "enter") {
        void runSearch();
        return;
      }
      const next = editText(search(), key);
      if (next) setSearch(next);
      return;
    }

    if (stage() === "results") {
      if (key.name === "down" || key.sequence === "j") {
        setRepoIdx((i) => Math.min(i + 1, Math.max(0, repos().length - 1)));
        return;
      }
      if (key.name === "up" || key.sequence === "k") {
        setRepoIdx((i) => Math.max(0, i - 1));
        return;
      }
      if ((key.name === "return" || key.name === "enter") && repos()[repoIdx()]) {
        void openRepo(repos()[repoIdx()]!.id);
      }
      return;
    }

    // stage === "files"
    if (key.name === "down" || key.sequence === "j") {
      setFileIdx((i) => Math.min(i + 1, Math.max(0, files().length - 1)));
      return;
    }
    if (key.name === "up" || key.sequence === "k") {
      setFileIdx((i) => Math.max(0, i - 1));
      return;
    }
    if ((key.name === "return" || key.name === "enter") && files()[fileIdx()]) {
      props.onPull(repo(), files()[fileIdx()]!.rfilename);
      props.onClose();
    }
  });

  /** Shortcuts usable at the current stage (and only when the list has rows). */
  const footerShortcuts = (): Shortcut[] => {
    if (stage() === "search") {
      return [
        { key: "Enter", desc: "search" },
        { key: "Esc", desc: "close" },
      ];
    }
    const items: Shortcut[] = [];
    if (stage() === "results") {
      if (repos().length > 0) {
        items.push({ key: "↑↓", desc: "move" });
        items.push({ key: "Enter", desc: "open repo" });
      }
    } else {
      if (files().length > 0) {
        items.push({ key: "↑↓", desc: "move" });
        items.push({ key: "Enter", desc: "download" });
      }
    }
    items.push({ key: "Esc", desc: "back" });
    return items;
  };

  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={C.border} backgroundColor={C.surface} paddingX={1}>
      <box flexDirection="row">
        <text fg={C.accent} attributes={TextAttributes.BOLD}>
          {`Hugging Face ${
            stage() === "search"
              ? "search"
              : stage() === "results"
                ? `· results for "${search().value}"`
                : `· ${repo()}`
          }`}
        </text>
      </box>

      <Show when={err()}>
        <box flexDirection="row">
          <text fg={C.danger}>⚠ {err()}</text>
        </box>
      </Show>
      <Show when={busy()}>
        <text attributes={TextAttributes.DIM}>working…</text>
      </Show>

      <Show when={stage() === "search"}>
        <box flexDirection="column">
          {/* Hint on its own line: keeping it off the input row leaves the value
              the full width, so the cursor never gets pushed onto a new line. */}
          <box flexDirection="row">
            <text>search: </text>
            <CursorText
              value={search().value}
              cursor={search().cursor}
              focused
              width={Math.max(8, props.columns - 4 - 8 - 1)}
            />
          </box>
          <text attributes={TextAttributes.DIM}>(Enter to search, Esc to close)</text>
        </box>
      </Show>

      <Show when={stage() === "results"}>
        <Show
          when={repos().length > 0}
          fallback={<text attributes={TextAttributes.DIM}>no repos found — Esc to edit the query</text>}
        >
          <For each={windowed(repos(), repoIdx()).slice}>
            {(r, j) => {
              const i = windowed(repos(), repoIdx()).start + j();
              return (
                <text bg={i === repoIdx() ? C.sel : undefined} fg={i === repoIdx() ? C.selText : C.text}>
                  {(i === repoIdx() ? "› " : "  ") + r.id +
                    `  ↓${r.downloads}` +
                    (r.gated ? "  [gated]" : "")}
                </text>
              );
            }}
          </For>
          <Show when={repos().length > MAX_ROWS}>
            <text attributes={TextAttributes.DIM}>{`  ${repoIdx() + 1}/${repos().length}`}</text>
          </Show>
        </Show>
      </Show>

      <Show when={stage() === "files"}>
        <Show
          when={files().length > 0}
          fallback={<text attributes={TextAttributes.DIM}>no GGUF files in this repo — Esc to go back</text>}
        >
          <For each={windowed(files(), fileIdx()).slice}>
            {(f, j) => {
              const i = windowed(files(), fileIdx()).start + j();
              return (
                <text bg={i === fileIdx() ? C.sel : undefined} fg={i === fileIdx() ? C.selText : C.text}>
                  {(i === fileIdx() ? "› " : "  ") + (f.quant ?? "?").padEnd(10) +
                    (f.sizeBytes != null ? humanBytes(f.sizeBytes).padStart(10) : "         —") +
                    "  " + f.rfilename}
                </text>
              );
            }}
          </For>
          <Show when={files().length > MAX_ROWS}>
            <text attributes={TextAttributes.DIM}>{`  ${fileIdx() + 1}/${files().length}`}</text>
          </Show>
        </Show>
      </Show>

      <box marginTop={1}>
        <ShortcutBar items={footerShortcuts()} />
      </box>
    </box>
  );
}
