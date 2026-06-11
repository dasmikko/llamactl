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

import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { InstanceConfig, LaunchSpec } from "../types.ts";
import type { Row } from "./rows.ts";
import { ShortcutBar, type Shortcut } from "./ShortcutBar.tsx";

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

const ACCENT = "#5f87ff"; // matches the catalog repo-header blue
const MUTED = "#9aa3b2";

/** One-line summary of the launch knobs a spec overrides (ctx, gpu layers). */
function summarizeSpec(spec: LaunchSpec): string {
  const parts: string[] = [];
  if (spec.ctxSize != null) parts.push(`ctx ${spec.ctxSize}`);
  if (spec.gpuLayers != null) parts.push(`ngl ${spec.gpuLayers}`);
  if (spec.nCpuMoe != null) parts.push(`cpu-moe ${spec.nCpuMoe}`);
  if (spec.flashAttn) parts.push(`fa ${spec.flashAttn}`);
  return parts.join(" · ");
}

export function ProfileDialog({
  variant,
  row,
  onLaunchProfile,
  onNew,
  onEdit,
  onDelete,
  onClose,
}: ProfileDialogProps): React.ReactElement {
  const profiles = row.profiles;
  const entries: Entry[] = [
    ...profiles.map((p) => ({ kind: "profile", profile: p }) as Entry),
    { kind: "new" } as Entry,
  ];

  const [sel, setSel] = useState(0);
  // The profile id armed for deletion (press d again / y to confirm), or null.
  const [armedDelete, setArmedDelete] = useState<string | null>(null);

  // Keep the cursor in range as the profile list shrinks (after a delete).
  useEffect(() => {
    if (sel > entries.length - 1) setSel(Math.max(0, entries.length - 1));
  }, [entries.length, sel]);

  const activate = (e: Entry): void => {
    if (e.kind === "new") onNew();
    else if (variant === "launch") onLaunchProfile(e.profile);
    else onEdit(e.profile);
  };

  useInput((input, key) => {
    if (key.escape) {
      if (armedDelete) setArmedDelete(null);
      else onClose();
      return;
    }
    if (key.downArrow || input === "j") {
      setArmedDelete(null);
      setSel((s) => Math.min(entries.length - 1, s + 1));
      return;
    }
    if (key.upArrow || input === "k") {
      setArmedDelete(null);
      setSel((s) => Math.max(0, s - 1));
      return;
    }
    const cur = entries[sel];
    if (!cur) return;
    if (key.return) {
      activate(cur);
      return;
    }
    if (variant === "manage" && input === "n") {
      onNew();
      return;
    }
    if (variant === "manage" && (input === "d" || (armedDelete && input === "y"))) {
      if (cur.kind !== "profile") return;
      if (armedDelete === cur.profile.id) {
        setArmedDelete(null);
        onDelete(cur.profile);
      } else {
        setArmedDelete(cur.profile.id);
      }
      return;
    }
  });

  const title =
    variant === "launch" ? `Launch  ${row.name}` : `Profiles  ${row.name}`;

  // Footer lists only what applies to the highlighted entry: the "+ New" row has
  // nothing to delete, and Enter means different things per variant/entry.
  const selKind = entries[sel]?.kind;
  const footerItems: Shortcut[] = [];
  if (entries.length > 1) footerItems.push({ key: "↑↓", desc: "select" });
  if (variant === "launch") {
    footerItems.push({ key: "Enter", desc: selKind === "new" ? "new + launch" : "launch" });
  } else {
    footerItems.push({ key: "Enter", desc: selKind === "new" ? "create" : "edit" });
    footerItems.push({ key: "n", desc: "new" });
    if (selKind === "profile") footerItems.push({ key: "d", desc: "delete" });
  }
  footerItems.push({ key: "Esc", desc: variant === "launch" ? "cancel" : "close" });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={ACCENT}
      paddingX={1}
      minWidth={44}
    >
      <Text bold color={ACCENT}>
        {title}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {entries.map((e, i) => {
          const selected = i === sel;
          const label = e.kind === "new" ? "+ New profile…" : e.profile.name;
          const hint = e.kind === "profile" ? summarizeSpec(e.profile.spec) : "";
          const arming = e.kind === "profile" && armedDelete === e.profile.id;
          const text = `${selected ? "›" : " "} ${label}`;
          return (
            <Box key={e.kind === "profile" ? `p:${e.profile.id}` : e.kind}>
              <Text inverse={selected} bold={selected} color={selected ? undefined : ACCENT}>
                {text}
              </Text>
              {arming ? (
                <Text color="#ff6b6b"> · delete? d/y to confirm</Text>
              ) : hint ? (
                <Text color={MUTED}>{`  ${hint}`}</Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <ShortcutBar items={footerItems} />
      </Box>
    </Box>
  );
}
