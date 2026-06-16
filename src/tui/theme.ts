/**
 * A single flat color palette for the TUI — a modern, Tokyo Night-inspired dark
 * scheme. Components import `C` and use semantic tokens instead of hardcoding
 * ANSI names, so the whole UI stays cohesive and is trivial to retune.
 *
 * All values are truecolor hex so they look identical across terminals (ANSI
 * names like "cyan"/"gray" drift a lot between themes). The app paints `C.bg` as
 * the root background so every frame fully repaints (no stale cells).
 */
export const C = {
  /** App background — painted on the root box so the whole screen fills. */
  bg: "#1a1b26",
  /** Raised surface (header facts panel, etc.). */
  surface: "#24283b",
  /** Selection bar background. */
  sel: "#2e3c64",
  /** Selection bar text. */
  selText: "#c0caf5",
  /** Subtle borders / separators. */
  border: "#3b4261",
  /** Primary body text. */
  text: "#c0caf5",
  /** De-emphasized text: column headers, hints, secondary labels. */
  muted: "#565f89",
  /** Primary accent (blue): titles, focused inputs, filter, active install. */
  accent: "#7aa2f7",
  /** Secondary accent (purple): downloads / HF panels, alt gauges. */
  accent2: "#bb9af7",
  /** Info / tertiary (light blue): VRAM gauge, repo group headers. */
  info: "#7dcfff",
  /** Positive state: ready, connected, success. */
  success: "#9ece6a",
  /** Caution state: starting/stopping, connecting, warnings. */
  warning: "#e0af68",
  /** Error / destructive state. */
  danger: "#f7768e",
  /** Favorite accent — the gold star and FAVORITES heading. */
  favorite: "#ff9e64",
  /** Repo/author group headers in the catalog. */
  group: "#7dcfff",
} as const;
