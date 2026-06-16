/**
 * Managed llama.cpp installs view: a list of built installs (one is active and
 * supplies the spawned binary) plus any in-flight / recent build jobs with live
 * progress. Pure/presentational — selection and keys live in app.tsx.
 */

import { For, Show, type JSX } from "solid-js";
import { TextAttributes } from "@opentui/core";
import type { LlamaInstall, BuildJob, BuildStatus } from "../types.ts";
import { humanBytes } from "./format.ts";
import { ShortcutBar, type Shortcut } from "./ShortcutBar.tsx";
import { C } from "./theme.ts";

export interface InstallsProps {
  installs: LlamaInstall[];
  builds: BuildJob[];
  activeId: string | null;
  /** Index into `installs` of the highlighted row, or -1 when none. */
  selectedIndex: number;
  /** Index into `builds` of the highlighted build row, or -1 when none. */
  selectedBuildIndex: number;
  /** Terminal width, so the build-log tail can be truncated to fit. */
  width: number;
  /** Context-aware footer shortcuts for the current selection. */
  shortcuts: Shortcut[];
}

function buildStatusColor(status: BuildStatus): string | undefined {
  switch (status) {
    case "ready":
      return C.success;
    case "error":
      return C.danger;
    case "canceled":
      return C.warning;
    case "queued":
      return C.muted;
    default:
      return C.accent;
  }
}

/** True while a build is still running (so its log tail is worth surfacing). */
function buildInFlight(status: BuildStatus): boolean {
  return (
    status === "queued" ||
    status === "cloning" ||
    status === "fetching" ||
    status === "configuring" ||
    status === "building" ||
    status === "installing"
  );
}

export function Installs(props: InstallsProps): JSX.Element {
  // Reserve a margin so the truncated log tail never wraps the terminal.
  const tailWidth = () => Math.max(10, props.width - 6);
  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={C.border}
      backgroundColor={C.surface}
      paddingX={1}
    >
      <text fg={C.accent} attributes={TextAttributes.BOLD}>
        MANAGED LLAMA.CPP INSTALLS
      </text>

      <box flexDirection="row">
        <box width={2}>
          <text> </text>
        </box>
        <box width={22}>
          <text attributes={TextAttributes.DIM}>NAME</text>
        </box>
        <box width={16}>
          <text attributes={TextAttributes.DIM}>REF</text>
        </box>
        <box width={7}>
          <text attributes={TextAttributes.DIM}>BACKEND</text>
        </box>
        <box width={16}>
          <text attributes={TextAttributes.DIM}>VERSION</text>
        </box>
        <box width={10}>
          <text attributes={TextAttributes.DIM}>SIZE</text>
        </box>
      </box>

      <Show
        when={props.installs.length > 0}
        fallback={
          <text attributes={TextAttributes.DIM}>(no managed installs — press n to build one)</text>
        }
      >
        <For each={props.installs}>
          {(ins, i) => {
            const selected = () => i() === props.selectedIndex;
            const active = () => ins.id === props.activeId;
            return (
              <box flexDirection="row">
                <box width={2}>
                  <text fg={C.favorite}>{active() ? "★" : " "}</text>
                </box>
                <box width={22}>
                  {/* wrap="truncate-end" dropped: clipped by box width + overflow. */}
                  <text bg={selected() ? C.sel : undefined} fg={selected() ? C.selText : C.text}>
                    {(selected() ? "› " : "  ") + ins.name}
                  </text>
                </box>
                <box width={16}>
                  <text>{ins.ref}</text>
                </box>
                <box width={7}>
                  <text>{ins.backend}</text>
                </box>
                <box width={16}>
                  <text>{ins.version ?? "—"}</text>
                </box>
                <box width={10}>
                  <text>{ins.sizeBytes != null ? humanBytes(ins.sizeBytes) : "—"}</text>
                </box>
                <Show when={active()}>
                  <text attributes={TextAttributes.DIM}> (active)</text>
                </Show>
              </box>
            );
          }}
        </For>
      </Show>

      <Show when={props.builds.length > 0}>
        <box flexDirection="column" marginTop={1}>
          <text fg={C.accent} attributes={TextAttributes.BOLD}>
            BUILDS
          </text>
          <For each={props.builds.slice(0, 5)}>
            {(b, i) => {
              const selected = () => i() === props.selectedBuildIndex;
              const inFlight = () => buildInFlight(b.status);
              const tail = b.logTail.length > 0 ? b.logTail[b.logTail.length - 1]! : "";
              const hint =
                b.status === "error"
                  ? (b.error ?? "build failed")
                  : inFlight()
                    ? tail
                    : b.status;
              const hintText = () =>
                hint.length > tailWidth() ? hint.slice(0, tailWidth() - 1) + "…" : hint;
              return (
                <box flexDirection="row">
                  <box width={22}>
                    {/* wrap="truncate-end" dropped: clipped by box width + overflow. */}
                    <text bg={selected() ? C.sel : undefined} fg={selected() ? C.selText : C.text}>
                      {(selected() ? "› " : "  ") + b.name}
                    </text>
                  </box>
                  <box width={12}>
                    <text fg={buildStatusColor(b.status)}>{b.status}</text>
                  </box>
                  <box flexGrow={1}>
                    {/* wrap="truncate-end" dropped: clipped by flexGrow box width. */}
                    <text
                      fg={b.status === "error" ? C.danger : C.text}
                      attributes={inFlight() ? TextAttributes.DIM : TextAttributes.NONE}
                    >
                      {hintText()}
                    </text>
                  </box>
                </box>
              );
            }}
          </For>
        </box>
      </Show>

      <box flexDirection="row" marginTop={1}>
        <ShortcutBar items={props.shortcuts} />
      </box>
    </box>
  );
}
