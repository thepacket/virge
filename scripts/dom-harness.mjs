/**
 * A DOM for the tests to drive main.js in.
 *
 * Everything in scripts/test.mjs is a pure-module check, and every bug reported
 * during this project has been in the layer those checks cannot see:
 *
 *   - renderGel destructured `mode` while callers passed `gelMode`, so
 *     pulsed-field mode silently never engaged
 *   - the import status kept naming the previously loaded sequence
 *   - Suggest appended to the lanes instead of replacing them
 *   - the Clear button was wiped by an innerHTML re-render
 *   - `hidden` was overridden by an author `display` rule
 *
 * None of those are reachable from a module test, and a screenshot passes for
 * all of them. This harness parses the real index.html, installs the browser
 * globals main.js needs, and records canvas drawing instead of rasterising it,
 * so a test can ask what was actually drawn.
 *
 * Deliberately not jsdom: this needs no layout and no real canvas, and a
 * recording context answers "was the ladder drawn at 20 distinct positions"
 * better than pixels would.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseHTML } from "linkedom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Canvas 2D calls, recorded rather than rendered. */
function recordingContext(calls) {
  const noop = () => {};
  const ctx = {
    canvas: null,
    // Every setter a caller might assign; recorded so a test can assert on the
    // fill colour of a band as easily as on its position.
    fillStyle: "", strokeStyle: "", font: "", textAlign: "", lineWidth: 1,
    setTransform: noop, save: noop, restore: noop, beginPath: noop,
    moveTo: noop, lineTo: noop, stroke: noop, clip: noop, setLineDash: noop,
    clearRect: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    fillRect: (x, y, w, h) => calls.push({ op: "fillRect", x, y, w, h, fill: ctx.fillStyle }),
    fillText: (text, x, y) => calls.push({ op: "fillText", text, x, y, fill: ctx.fillStyle }),
    measureText: (t) => ({ width: t.length * 6 }),
  };
  return ctx;
}

/** Give <select> a working value setter, matching browser behaviour. */
function patchSelectValue(window, document) {
  const proto = document.createElement("select").constructor.prototype;
  const own = Object.getOwnPropertyDescriptor(proto, "value");
  if (own?.set) return; // a future linkedom may fix this
  Object.defineProperty(proto, "value", {
    configurable: true,
    get() {
      const opts = [...this.querySelectorAll("option")];
      const sel = opts.find((o) => o.selected) || opts[0];
      return sel ? (sel.hasAttribute("value") ? sel.getAttribute("value") : sel.textContent) : "";
    },
    set(v) {
      for (const o of this.querySelectorAll("option")) {
        const ov = o.hasAttribute("value") ? o.getAttribute("value") : o.textContent;
        // Assigning an unknown value leaves the selection alone, as in a browser.
        if (ov === String(v)) { o.selected = true; o.setAttribute("selected", ""); }
        else { o.selected = false; o.removeAttribute("selected"); }
      }
    },
  });
}

/** `details.open` is a reflected boolean attribute: browsers mirror the property
 *  onto the attribute, linkedom does not. Without this, `d.open = true` leaves
 *  `[open]` absent and a test asserting on the attribute fails against code that
 *  is correct in a browser. */
function patchDetailsOpen(document) {
  const proto = document.createElement("details").constructor.prototype;
  if (Object.getOwnPropertyDescriptor(proto, "__virgeOpen")) return;
  Object.defineProperty(proto, "__virgeOpen", { value: true });
  Object.defineProperty(proto, "open", {
    configurable: true,
    get() { return this.hasAttribute("open"); },
    set(v) { v ? this.setAttribute("open", "") : this.removeAttribute("open"); },
  });
}

/**
 * Builds the DOM, installs globals, and imports main.js.
 *
 * Returns { document, window, calls, storage, reset }. `calls` accumulates
 * canvas operations; call reset() before an action to see only what it drew.
 */
export async function loadApp() {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const { window, document } = parseHTML(html);

  const calls = [];
  const storage = new Map();
  const localStorageStub = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
  };

  // main.js sizes the canvas from its CSS box; linkedom does no layout, so
  // clientWidth/clientHeight stay 0 and renderGel takes its 760x560 fallback.
  // That fallback exists for the same reason, so the tests exercise a real path.
  for (const canvas of document.querySelectorAll("canvas")) {
    canvas.getContext = () => {
      const ctx = recordingContext(calls);
      ctx.canvas = canvas;
      return ctx;
    };
    canvas.toDataURL = () => "data:image/png;base64,";
  }

  // linkedom exposes <select>.value as a getter derived from the selected
  // option, so `el.value = "pfge"` throws. Browsers accept the assignment and
  // move the selection, and main.js relies on that, so make it behave.
  patchSelectValue(window, document);
  patchDetailsOpen(document);
  // linkedom leaves compatMode undefined, which KaTeX reads as quirks mode and
  // warns about on every run. Both index.html and the built dist/index.html do
  // carry a doctype, so the warning is a harness artefact — and test output
  // people learn to scroll past is test output they stop reading.
  if (!document.compatMode) {
    Object.defineProperty(document, "compatMode", { value: "CSS1Compat", configurable: true });
  }

  Object.assign(globalThis, {
    window,
    document,
    localStorage: localStorageStub,
    devicePixelRatio: 1,
    requestAnimationFrame: (fn) => { fn(0); return 0; },
    cancelAnimationFrame: () => {},
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
  });
  window.localStorage = localStorageStub;
  window.devicePixelRatio = 1;
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  // The assistant reaches for fetch on construction paths the tests never take;
  // fail loudly rather than hitting the network if that ever changes.
  globalThis.fetch = async () => { throw new Error("no network in tests"); };

  await import("../src/main.js");

  return {
    window, document, calls, storage,
    reset: () => { calls.length = 0; },
    $: (sel) => document.querySelector(sel),
    $$: (sel) => [...document.querySelectorAll(sel)],
    /** Fire the change/input event a <select> or <input> listener waits for. */
    set(sel, value, type = "change") {
      const el = document.querySelector(sel);
      el.value = value;
      el.dispatchEvent(new window.Event(type, { bubbles: true }));
      return el;
    },
    /** Tick or untick a checkbox the way a browser does: flip it, then fire
     *  `change`. A bare click event does not toggle `checked` here, and a
     *  helper that silently did nothing would let a test pass vacuously. */
    setChecked(sel, on = true) {
      const el = typeof sel === "string" ? document.querySelector(sel) : sel;
      if (!el) throw new Error(`setChecked: no element for ${sel}`);
      el.checked = on;
      el.dispatchEvent(new window.Event("change", { bubbles: true }));
      return el;
    },
    click(sel) {
      const el = typeof sel === "string" ? document.querySelector(sel) : sel;
      el.dispatchEvent(new window.Event("click", { bubbles: true }));
      return el;
    },
    /** Text drawn on the gel this action — the readable part of the canvas. */
    drawnText: () => calls.filter((c) => c.op === "fillText").map((c) => c.text),
  };
}
