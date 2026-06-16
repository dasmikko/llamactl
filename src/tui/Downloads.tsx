/**
 * Downloads section: a compact progress list of active and recently-finished
 * Hugging Face downloads, shown above the model lists. Pure/presentational.
 */

import { For, Show, type JSX } from "solid-js";
import { TextAttributes } from "@opentui/core";
import type { Download } from "../types.ts";
import { bar, pct, humanBytes } from "./format.ts";
import { C } from "./theme.ts";

export interface DownloadsProps {
  downloads: Download[];
  /** Index of the highlighted row in the managed view, or -1 for none (inline). */
  selectedIndex?: number;
  /** Render the "DOWNLOADS" header (default true; the managed view supplies its own). */
  showHeader?: boolean;
}

const GAUGE_WIDTH = 16;

function statusColor(status: Download["status"]): string | undefined {
  switch (status) {
    case "done":
      return C.success;
    case "error":
      return C.danger;
    case "canceled":
      return C.warning;
    default:
      return C.accent;
  }
}

export function Downloads(props: DownloadsProps): JSX.Element {
  const selectedIndex = () => props.selectedIndex ?? -1;
  const showHeader = () => props.showHeader ?? true;
  // The managed view passes a selection and wants all rows; the inline strip
  // caps at 5. (selectedIndex >= 0 ⇒ managed view.)
  const managed = () => selectedIndex() >= 0;
  const rows = () => (managed() ? props.downloads : props.downloads.slice(0, 5));
  return (
    <Show when={props.downloads.length > 0}>
      <box flexDirection="column">
        <Show when={showHeader()}>
          <text fg={C.accent} attributes={TextAttributes.BOLD}>
            DOWNLOADS
          </text>
        </Show>
        <For each={rows()}>
          {(d, i) => {
            const selected = () => i() === selectedIndex();
            const frac = d.totalBytes ? d.receivedBytes / d.totalBytes : 0;
            const label = `${d.repo}/${d.file.split("/").pop() ?? d.file}`;
            const size = d.totalBytes
              ? `${humanBytes(d.receivedBytes)} / ${humanBytes(d.totalBytes)}`
              : humanBytes(d.receivedBytes);
            return (
              <box flexDirection="row">
                <Show when={managed()}>
                  <box width={2}>
                    <text fg={C.text}>{selected() ? "›" : " "}</text>
                  </box>
                </Show>
                <box width={36}>
                  <text bg={selected() ? C.sel : undefined} fg={selected() ? C.selText : C.text}>
                    {label.length > 35 ? "…" + label.slice(-34) : label}
                  </text>
                </box>
                <text fg={statusColor(d.status)}>
                  {bar(d.receivedBytes, d.totalBytes ?? 0, GAUGE_WIDTH)}
                </text>
                <text fg={C.text}>
                  {" "}
                  {d.status === "downloading" ? pct(frac * 100) : d.status}
                  {"  " + size}
                </text>
                <Show when={managed() && d.status === "error" && d.error}>
                  <text fg={C.danger}> — {d.error}</text>
                </Show>
              </box>
            );
          }}
        </For>
      </box>
    </Show>
  );
}
