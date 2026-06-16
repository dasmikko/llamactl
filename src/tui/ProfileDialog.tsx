/**
 * A floating, centered modal for choosing what to launch ("launch" variant) or
 * managing a model's saved profiles ("manage" variant). A model is one row in
 * the catalog; its profiles live here rather than as their own rows.
 *
 *  - launch:  Default · <profiles…> · + New profile.  Enter launches the entry.
 *  - manage:  <profiles…> · + New profile.            Enter edits, n new, d del.
 *
 * Owns its own keyboard input (the app's top-level handler is gated off while a
 * modal is open), so it captures ↑/↓/Enter/Esc and, in manage mode, n/d.
 */

import { createSignal, createMemo, createEffect, For, Show } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { TextAttributes } from "@opentui/core";
import type { InstanceConfig, LaunchSpec } from "../types.ts";
import type { Row } from "./rows.ts";
import { ShortcutBar, type Shortcut } from "./ShortcutBar.tsx";
import { C } from "./theme.ts";

export interface ProfileDialogProps {
  variant: "launch" | "manage";
  /** The model row whose profiles are being chosen/managed. */
  row: Row;
  /** Launch the given saved profile. */
  onLaunchProfile: (p: InstanceConfig) => void;
  /** Create a new profile (the editor decides whether to launch after). */
  onNew: () => void;
  /** Edit an existing profile's flags. */
  onEdit: (p: InstanceConfig) => void;
  /** Delete an existing profile. */
  onDelete: (p: InstanceConfig) => void;
  onClose: () => void;
}

type Entry = { kind: "profile"; profile: InstanceConfig } | { kind: "new" };

const ACCENT = C.accent;
const MUTED = C.muted;

/** One-line summary of the launch knobs a spec overrides (ctx, gpu layers). */
function summarizeSpec(spec: LaunchSpec): string {
  const parts: string[] = [];
  if (spec.ctxSize != null) parts.push(`ctx ${spec.ctxSize}`);
  if (spec.gpuLayers != null) parts.push(`ngl ${spec.gpuLayers}`);
  if (spec.nCpuMoe != null) parts.push(`cpu-moe ${spec.nCpuMoe}`);
  if (spec.flashAttn) parts.push(`fa ${spec.flashAttn}`);
  return parts.join(" · ");
}

export function ProfileDialog(props: ProfileDialogProps) {
  const entries = createMemo<Entry[]>(() => [
    ...props.row.profiles.map((p) => ({ kind: "profile", profile: p }) as Entry),
    { kind: "new" } as Entry,
  ]);

  const [sel, setSel] = createSignal(0);
  // The profile id armed for deletion (press d again / y to confirm), or null.
  const [armedDelete, setArmedDelete] = createSignal<string | null>(null);

  // Keep the cursor in range as the profile list shrinks (after a delete).
  createEffect(() => {
    if (sel() > entries().length - 1) setSel(Math.max(0, entries().length - 1));
  });

  const activate = (e: Entry): void => {
    if (e.kind === "new") props.onNew();
    else if (props.variant === "launch") props.onLaunchProfile(e.profile);
    else props.onEdit(e.profile);
  };

  useKeyboard((key) => {
    if (key.name === "escape") {
      if (armedDelete()) setArmedDelete(null);
      else props.onClose();
      return;
    }
    if (key.name === "down" || key.sequence === "j") {
      setArmedDelete(null);
      setSel((s) => Math.min(entries().length - 1, s + 1));
      return;
    }
    if (key.name === "up" || key.sequence === "k") {
      setArmedDelete(null);
      setSel((s) => Math.max(0, s - 1));
      return;
    }
    const cur = entries()[sel()];
    if (!cur) return;
    if (key.name === "return" || key.name === "enter") {
      activate(cur);
      return;
    }
    if (props.variant === "manage" && key.sequence === "n") {
      props.onNew();
      return;
    }
    if (
      props.variant === "manage" &&
      (key.sequence === "d" || (armedDelete() && key.sequence === "y"))
    ) {
      if (cur.kind !== "profile") return;
      if (armedDelete() === cur.profile.id) {
        setArmedDelete(null);
        props.onDelete(cur.profile);
      } else {
        setArmedDelete(cur.profile.id);
      }
      return;
    }
  });

  const title = () =>
    props.variant === "launch" ? `Launch  ${props.row.name}` : `Profiles  ${props.row.name}`;

  // Footer lists only what applies to the highlighted entry: the "+ New" row has
  // nothing to delete, and Enter means different things per variant/entry.
  const footerItems = (): Shortcut[] => {
    const selKind = entries()[sel()]?.kind;
    const items: Shortcut[] = [];
    if (entries().length > 1) items.push({ key: "↑↓", desc: "select" });
    if (props.variant === "launch") {
      items.push({ key: "Enter", desc: selKind === "new" ? "new + launch" : "launch" });
    } else {
      items.push({ key: "Enter", desc: selKind === "new" ? "create" : "edit" });
      items.push({ key: "n", desc: "new" });
      if (selKind === "profile") items.push({ key: "d", desc: "delete" });
    }
    items.push({ key: "Esc", desc: props.variant === "launch" ? "cancel" : "close" });
    return items;
  };

  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={C.border}
      backgroundColor={C.surface}
      paddingX={1}
      minWidth={44}
    >
      <text fg={ACCENT} attributes={TextAttributes.BOLD}>
        {title()}
      </text>
      <box flexDirection="column" marginTop={1}>
        <For each={entries()}>
          {(e, i) => {
            const selected = () => i() === sel();
            const label = e.kind === "new" ? "+ New profile…" : e.profile.name;
            const hint = e.kind === "profile" ? summarizeSpec(e.profile.spec) : "";
            const arming = () =>
              e.kind === "profile" && armedDelete() === e.profile.id;
            const labelText = () => `${selected() ? "›" : " "} ${label}`;
            return (
              <box flexDirection="row">
                <text
                  bg={selected() ? C.sel : undefined}
                  fg={selected() ? C.selText : C.text}
                  attributes={selected() ? TextAttributes.BOLD : TextAttributes.NONE}
                >
                  {labelText()}
                </text>
                <Show when={arming()} fallback={
                  <Show when={hint}>
                    <text fg={MUTED}>{`  ${hint}`}</text>
                  </Show>
                }>
                  <text fg={C.danger}> · delete? d/y to confirm</text>
                </Show>
              </box>
            );
          }}
        </For>
      </box>
      <box marginTop={1}>
        <ShortcutBar items={footerItems()} />
      </box>
    </box>
  );
}
