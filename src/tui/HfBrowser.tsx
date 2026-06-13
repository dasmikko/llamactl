/**
 * Hugging Face browse-and-pull modal. Three stages: a search box, a list of
 * matching repos, and a list of the repo's GGUF files. Picking a file kicks off
 * a download (tracked in the Downloads section) and closes the modal. Esc steps
 * back a stage, then closes. Hand-rolled input via useInput — no extra deps.
 */

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { HfRepo, HfFile } from "../types.ts";
import { humanBytes } from "./format.ts";
import { ShortcutBar, type Shortcut } from "./ShortcutBar.tsx";
import { editText, CursorText } from "./textinput.tsx";

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

export function HfBrowser({
  searchHf,
  listHfFiles,
  onPull,
  onClose,
  columns,
}: HfBrowserProps): React.ReactElement {
  const [stage, setStage] = useState<Stage>("search");
  const [query, setQuery] = useState("");
  const [queryCursor, setQueryCursor] = useState(0);
  const [repos, setRepos] = useState<HfRepo[]>([]);
  const [repoIdx, setRepoIdx] = useState(0);
  const [repo, setRepo] = useState("");
  const [files, setFiles] = useState<HfFile[]>([]);
  const [fileIdx, setFileIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const runSearch = async (): Promise<void> => {
    if (query.trim() === "") return;
    setBusy(true);
    setErr(null);
    try {
      const r = await searchHf(query.trim());
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
      const f = await listHfFiles(id);
      setFiles(f);
      setFileIdx(0);
      setStage("files");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useInput((input, key) => {
    if (busy) return; // ignore keys while a request is in flight

    if (key.escape) {
      if (stage === "files") setStage("results");
      else if (stage === "results") setStage("search");
      else onClose();
      return;
    }

    if (stage === "search") {
      if (key.return) {
        void runSearch();
        return;
      }
      const next = editText({ value: query, cursor: queryCursor }, input, key);
      if (next) {
        setQuery(next.value);
        setQueryCursor(next.cursor);
      }
      return;
    }

    if (stage === "results") {
      if (key.downArrow || input === "j") {
        setRepoIdx((i) => Math.min(i + 1, Math.max(0, repos.length - 1)));
        return;
      }
      if (key.upArrow || input === "k") {
        setRepoIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (key.return && repos[repoIdx]) void openRepo(repos[repoIdx]!.id);
      return;
    }

    // stage === "files"
    if (key.downArrow || input === "j") {
      setFileIdx((i) => Math.min(i + 1, Math.max(0, files.length - 1)));
      return;
    }
    if (key.upArrow || input === "k") {
      setFileIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.return && files[fileIdx]) {
      onPull(repo, files[fileIdx]!.rfilename);
      onClose();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">
        Hugging Face {stage === "search" ? "search" : stage === "results" ? `· results for "${query}"` : `· ${repo}`}
      </Text>

      {err ? <Text color="red">⚠ {err}</Text> : null}
      {busy ? <Text dimColor>working…</Text> : null}

      {stage === "search" ? (
        <Box flexDirection="column">
          {/* Hint on its own line: keeping it off the input row leaves the value
              the full width, so the cursor never gets pushed onto a new line. */}
          <Box>
            <Text>search: </Text>
            <CursorText
              value={query}
              cursor={queryCursor}
              focused
              width={Math.max(8, columns - 4 - 8 - 1)}
            />
          </Box>
          <Text dimColor>(Enter to search, Esc to close)</Text>
        </Box>
      ) : null}

      {stage === "results" ? (
        repos.length === 0 ? (
          <Text dimColor>no repos found — Esc to edit the query</Text>
        ) : (
          (() => {
            const w = windowed(repos, repoIdx);
            return (
              <>
                {w.slice.map((r, j) => {
                  const i = w.start + j;
                  return (
                    <Text key={r.id} inverse={i === repoIdx}>
                      {(i === repoIdx ? "› " : "  ") + r.id}
                      {`  ↓${r.downloads}`}
                      {r.gated ? "  [gated]" : ""}
                    </Text>
                  );
                })}
                {repos.length > MAX_ROWS ? (
                  <Text dimColor>{`  ${repoIdx + 1}/${repos.length}`}</Text>
                ) : null}
              </>
            );
          })()
        )
      ) : null}

      {stage === "files" ? (
        files.length === 0 ? (
          <Text dimColor>no GGUF files in this repo — Esc to go back</Text>
        ) : (
          (() => {
            const w = windowed(files, fileIdx);
            return (
              <>
                {w.slice.map((f, j) => {
                  const i = w.start + j;
                  return (
                    <Text key={f.rfilename} inverse={i === fileIdx}>
                      {(i === fileIdx ? "› " : "  ") + (f.quant ?? "?").padEnd(10)}
                      {f.sizeBytes != null ? humanBytes(f.sizeBytes).padStart(10) : "         —"}
                      {"  " + f.rfilename}
                    </Text>
                  );
                })}
                {files.length > MAX_ROWS ? (
                  <Text dimColor>{`  ${fileIdx + 1}/${files.length}`}</Text>
                ) : null}
              </>
            );
          })()
        )
      ) : null}

      <Box marginTop={1}>
        <ShortcutBar items={footerShortcuts()} />
      </Box>
    </Box>
  );

  /** Shortcuts usable at the current stage (and only when the list has rows). */
  function footerShortcuts(): Shortcut[] {
    if (stage === "search") {
      return [
        { key: "Enter", desc: "search" },
        { key: "Esc", desc: "close" },
      ];
    }
    const items: Shortcut[] = [];
    if (stage === "results") {
      if (repos.length > 0) {
        items.push({ key: "↑↓", desc: "move" });
        items.push({ key: "Enter", desc: "open repo" });
      }
    } else {
      if (files.length > 0) {
        items.push({ key: "↑↓", desc: "move" });
        items.push({ key: "Enter", desc: "download" });
      }
    }
    items.push({ key: "Esc", desc: "back" });
    return items;
  }
}
