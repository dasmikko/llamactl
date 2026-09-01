/**
 * Minimal DOM + formatting helpers. No framework: the UI is small enough that
 * `el()` plus targeted re-renders is less machinery than a runtime would be,
 * and it keeps the front end buildless.
 */

/**
 * Create an element. Props are assigned as DOM properties (so `onclick`,
 * `className`, `value`, `disabled` all work), except `style` and `dataset`,
 * which are merged, and `attrs`, which sets real attributes. Children may be
 * nodes, strings, or nullish (skipped) — nested arrays are flattened.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === "style" || k === "dataset") Object.assign(node[k], v);
    else if (k === "attrs") for (const [a, av] of Object.entries(v)) node.setAttribute(a, av);
    else node[k] = v;
  }
  append(node, children);
  return node;
}

/** Append children (flattening arrays, skipping nullish) to a node. */
export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child);
  }
  return node;
}

/** Replace a node's children in one shot. */
export function fill(node, ...children) {
  node.replaceChildren();
  return append(node, children);
}

/** Human-readable byte size, mirroring humanBytes in src/cli/output.ts. */
export function bytes(n) {
  if (!Number.isFinite(n) || n < 0) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`;
}

/** Human-readable duration from an epoch ms to now, mirroring humanUptime. */
export function uptime(startedAtMs, nowMs = Date.now()) {
  const secs = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d${hrs % 24}h`;
}

/** Percent with no decimals, e.g. 42 → "42%". */
export function pct(n) {
  return `${Math.round(n)}%`;
}

/** Format a supported context length, e.g. 131072 → "131072 (128K)". */
export function ctxText(n) {
  if (n === null || n === undefined) return "—";
  return n >= 1024 ? `${n} (${Math.round(n / 1024)}K)` : String(n);
}

/** A small labelled form row. */
export function field(label, control, help) {
  return el(
    "div",
    { className: "field" },
    el("label", { textContent: label }),
    control,
    help ? el("span", { className: "help", textContent: help }) : null,
  );
}

/** A `<select>` bound to options `[value, label]`, with `value` preselected. */
export function select(options, value, onchange) {
  const node = el("select", { onchange: (e) => onchange(e.target.value) });
  for (const [v, label] of options) {
    node.append(el("option", { value: v, textContent: label, selected: v === value }));
  }
  node.value = value ?? "";
  return node;
}

/**
 * A wrapped group of checkboxes for a flag that takes several values at once.
 * `selected` is the current list; `onchange` receives the new list in the same
 * order as `options`, so the value the daemon sees is stable regardless of the
 * order boxes were ticked in.
 */
export function checkboxGroup(options, selected, onchange) {
  const chosen = new Set(selected);
  const node = el("div", { className: "checks" });
  for (const value of options) {
    const box = el("input", {
      type: "checkbox",
      checked: chosen.has(value),
      onchange: (e) => {
        if (e.target.checked) chosen.add(value);
        else chosen.delete(value);
        onchange(options.filter((o) => chosen.has(o)));
      },
    });
    node.append(el("label", { className: "check" }, box, value));
  }
  return node;
}
