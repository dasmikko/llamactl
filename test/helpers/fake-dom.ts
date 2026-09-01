/**
 * A tiny DOM stand-in, enough to execute the web UI's render path under `bun
 * test`. There is no browser here and no jsdom dependency, so this implements
 * only the handful of APIs src/web/public actually touches — element creation,
 * children, classes, dataset, events — plus a `text()` walker for assertions.
 *
 * It is deliberately not a DOM: it exists so a render regression (a bad
 * property name, a missing helper, a broken row join) fails a test instead of
 * a blank page.
 */

export class FakeElement {
  readonly tag: string;
  readonly children: (FakeElement | string)[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners: Record<string, ((e: unknown) => void)[]> = {};
  readonly attributes: Record<string, string> = {};
  parentElement: FakeElement | null = null;

  className = "";
  title = "";
  href = "";
  value = "";
  type = "";
  placeholder = "";
  hidden = false;
  disabled = false;
  checked = false;
  selected = false;
  target = "";
  rel = "";
  colSpan = 0;
  scrollTop = 0;
  clientHeight = 0;
  scrollHeight = 0;
  onclick: (() => void) | null = null;
  oninput: ((e: unknown) => void) | null = null;
  onchange: ((e: unknown) => void) | null = null;
  onkeydown: ((e: unknown) => void) | null = null;

  constructor(tag: string) {
    this.tag = tag;
  }

  /** Text content: reading walks the subtree, writing replaces it. */
  get textContent(): string {
    return this.children
      .map((c) => (typeof c === "string" ? c : c.textContent))
      .join("");
  }

  set textContent(value: string) {
    this.children.length = 0;
    if (value !== "") this.children.push(String(value));
  }

  get lastChild(): FakeElement | string | undefined {
    return this.children[this.children.length - 1];
  }

  append(...nodes: (FakeElement | string | null | undefined)[]): void {
    for (const n of nodes) {
      if (n === null || n === undefined) continue;
      if (n instanceof FakeElement) n.parentElement = this;
      this.children.push(n instanceof FakeElement ? n : String(n));
    }
  }

  replaceChildren(...nodes: (FakeElement | string)[]): void {
    this.children.length = 0;
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  addEventListener(type: string, fn: (e: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }

  focus(): void {
    /* no focus model here */
  }

  /** Every element in the subtree, including this one. */
  descendants(): FakeElement[] {
    const out: FakeElement[] = [this];
    for (const c of this.children) if (c instanceof FakeElement) out.push(...c.descendants());
    return out;
  }

  /** Elements whose className contains `cls`, in document order. */
  byClass(cls: string): FakeElement[] {
    return this.descendants().filter((e) => e.className.split(/\s+/).includes(cls));
  }

  byTag(tag: string): FakeElement[] {
    return this.descendants().filter((e) => e.tag === tag);
  }

  /** Visible text of the subtree, with one line per element that has text. */
  lines(): string[] {
    return this.descendants()
      .map((e) => e.textContent.trim())
      .filter((t) => t.length > 0);
  }
}

export interface FakeDom {
  /** Elements registered by id, so getElementById works. */
  byId: Map<string, FakeElement>;
  restore: () => void;
}

/**
 * Install the stub on globalThis and return a handle. Call `restore()` in an
 * afterAll so other test files see a clean global.
 */
export function installFakeDom(ids: string[] = []): FakeDom {
  const byId = new Map<string, FakeElement>();
  for (const id of ids) byId.set(id, new FakeElement("div"));

  const document = {
    createElement: (tag: string) => new FakeElement(tag),
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [] as FakeElement[],
    addEventListener: () => {},
  };

  const saved = {
    document: (globalThis as Record<string, unknown>).document,
    window: (globalThis as Record<string, unknown>).window,
  };

  (globalThis as Record<string, unknown>).document = document;
  (globalThis as Record<string, unknown>).window = {
    confirm: () => true,
    prompt: () => null,
  };

  return {
    byId,
    restore: () => {
      (globalThis as Record<string, unknown>).document = saved.document;
      (globalThis as Record<string, unknown>).window = saved.window;
    },
  };
}
