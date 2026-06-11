/**
 * TUI color theme: a small set of *semantic* tokens (accent, success, danger…)
 * that every presentational component reads from React context, plus a handful
 * of built-in palettes. Components never hardcode an Ink color name; they map an
 * intent (a heading, a warning, a gauge) onto a token, so swapping the active
 * theme recolors the whole UI consistently.
 *
 * The active theme lives in app state (so it can be cycled live) and is provided
 * through `ThemeContext`; read it with `useTheme()`. The chosen name is persisted
 * in the config file (`config.theme`).
 */

import React from "react";

/** Stable identifiers for the built-in themes (also the persisted value). */
export type ThemeName = "default" | "dracula" | "nord" | "gruvbox" | "mono";

export interface Theme {
  /** Stable identifier; also what's persisted in `config.theme`. */
  name: ThemeName;
  /** Human-facing label for the switcher / help. */
  label: string;
  /** Primary accent: section titles, CPU/RAM gauges, focused inputs, filter, active-install marker. */
  accent: string;
  /** Secondary accent: alternate panels (downloads / HF browser), GPU-util gauge, memory estimate. */
  accentAlt: string;
  /** Tertiary accent: installs / build panels and the VRAM gauge. */
  info: string;
  /** Positive state: ready, connected, log "follow", the confirm key. */
  success: string;
  /** Caution state: starting/stopping, connecting, scrolled-up, the log-viewer frame. */
  warning: string;
  /** Error / destructive state: crashes, errors, danger frames. */
  danger: string;
  /** Favorite accent — the gold star and the FAVORITES heading. */
  favorite: string;
  /** De-emphasized text: column headers, hints, secondary labels. */
  muted: string;
  /** Primary body text; `undefined` keeps the terminal's own default foreground. */
  text: string | undefined;
  /**
   * Screen background. A hex color is pushed to the terminal as its default
   * background (OSC 11) so the *entire* alternate screen — including the gaps
   * Ink leaves between widgets — is painted; `null` keeps the terminal's own
   * background (used by the neutral "default"/"mono" themes).
   */
  bg: string | null;
  /** Palette for the confirm dialog, which hand-paints a solid filled panel. */
  dialog: {
    bg: string;
    border: string;
    text: string;
    muted: string;
    confirm: string;
  };
}

/**
 * The original look, preserved verbatim as the default theme: the standard ANSI
 * color names (so it renders identically on every terminal palette) plus the
 * dialog's truecolor slate. `text: undefined` means "use the terminal default".
 */
const DEFAULT: Theme = {
  name: "default",
  label: "Default",
  accent: "cyan",
  accentAlt: "magenta",
  info: "blue",
  success: "green",
  warning: "yellow",
  danger: "red",
  favorite: "#ff8700",
  muted: "gray",
  text: undefined,
  bg: null,
  dialog: {
    bg: "#1b1e26",
    border: "#ff6b6b",
    text: "#eef1f6",
    muted: "#9aa3b2",
    confirm: "#7ee787",
  },
};

const DRACULA: Theme = {
  name: "dracula",
  label: "Dracula",
  accent: "#8be9fd",
  accentAlt: "#ff79c6",
  info: "#bd93f9",
  success: "#50fa7b",
  warning: "#f1fa8c",
  danger: "#ff5555",
  favorite: "#ffb86c",
  muted: "#6272a4",
  text: "#f8f8f2",
  bg: "#282a36",
  dialog: {
    bg: "#282a36",
    border: "#ff5555",
    text: "#f8f8f2",
    muted: "#6272a4",
    confirm: "#50fa7b",
  },
};

const NORD: Theme = {
  name: "nord",
  label: "Nord",
  accent: "#88c0d0",
  accentAlt: "#b48ead",
  info: "#81a1c1",
  success: "#a3be8c",
  warning: "#ebcb8b",
  danger: "#bf616a",
  favorite: "#d08770",
  muted: "#616e88",
  text: "#d8dee9",
  bg: "#2e3440",
  dialog: {
    bg: "#2e3440",
    border: "#bf616a",
    text: "#eceff4",
    muted: "#616e88",
    confirm: "#a3be8c",
  },
};

const GRUVBOX: Theme = {
  name: "gruvbox",
  label: "Gruvbox",
  accent: "#8ec07c",
  accentAlt: "#d3869b",
  info: "#83a598",
  success: "#b8bb26",
  warning: "#fabd2f",
  danger: "#fb4934",
  favorite: "#fe8019",
  muted: "#928374",
  text: "#ebdbb2",
  bg: "#282828",
  dialog: {
    bg: "#282828",
    border: "#fb4934",
    text: "#ebdbb2",
    muted: "#928374",
    confirm: "#b8bb26",
  },
};

/**
 * A 16-color-safe, near-monochrome theme for limited terminals: decorative
 * accents collapse to white while the status colors (success/warning/danger)
 * stay distinct, so meaning survives even without truecolor.
 */
const MONO: Theme = {
  name: "mono",
  label: "Mono",
  accent: "white",
  accentAlt: "white",
  info: "white",
  success: "green",
  warning: "yellow",
  danger: "red",
  favorite: "yellow",
  muted: "gray",
  text: "white",
  bg: null,
  dialog: {
    bg: "black",
    border: "white",
    text: "white",
    muted: "gray",
    confirm: "green",
  },
};

/** All built-in themes, keyed by name. */
export const THEMES: Record<ThemeName, Theme> = {
  default: DEFAULT,
  dracula: DRACULA,
  nord: NORD,
  gruvbox: GRUVBOX,
  mono: MONO,
};

/** Cycle order for the live switcher (the `t` key). */
export const THEME_ORDER: ThemeName[] = ["default", "dracula", "nord", "gruvbox", "mono"];

/** Resolve a (possibly untrusted) name to a theme, falling back to the default. */
export function resolveTheme(name: string | null | undefined): Theme {
  if (name && name in THEMES) return THEMES[name as ThemeName];
  return DEFAULT;
}

/** The next theme name in cycle order, wrapping around. */
export function nextTheme(name: ThemeName): ThemeName {
  const i = THEME_ORDER.indexOf(name);
  return THEME_ORDER[(i + 1) % THEME_ORDER.length]!;
}

/** Reset the terminal's default background to its native value (OSC 111). */
export function resetThemeBackground(): void {
  if (process.stdout.isTTY) process.stdout.write("\x1b]111\x07");
}

/**
 * Paint the whole alternate screen by pushing the theme's background to the
 * terminal as its default (OSC 11), or resetting to native when the theme keeps
 * the terminal's own background. Unsupported terminals simply ignore the escape.
 */
export function applyThemeBackground(theme: Theme): void {
  if (!process.stdout.isTTY) return;
  if (theme.bg) process.stdout.write(`\x1b]11;${theme.bg}\x07`);
  else resetThemeBackground();
}

/** Context carrying the active theme; defaults to the original look. */
export const ThemeContext = React.createContext<Theme>(DEFAULT);

/** Read the active theme from anywhere in the TUI tree. */
export function useTheme(): Theme {
  return React.useContext(ThemeContext);
}
