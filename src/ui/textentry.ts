// Controller-friendly text entry: an on-screen keyboard that also accepts
// physical typing and paste (needed for API keys).
import { h, icon } from "../dom";
import { captureText, type ActionEvent } from "../input";
import { router } from "../router";
import { cue } from "../sound";

const LAYOUT = ["abcdefghij", "klmnopqrst", "uvwxyz-_.@", "1234567890"];

export interface TextEntryOptions {
  title: string;
  hint?: string;
  value?: string;
  secret?: boolean;
  submitLabel?: string;
  onSubmit: (value: string) => void;
}

export function openTextEntry(o: TextEntryOptions) {
  let value = o.value ?? "";
  let upper = false;
  let r = 0;
  let c = 0;

  const field = h("div.te-field");
  const keysEl = h("div.te-keys");
  const special = [
    { label: "⇧", run: () => ((upper = !upper), render()) },
    { label: icon("space"), run: () => type(" ") },
    { label: icon("backspace"), run: () => type(null) },
    { label: "Paste", run: () => paste() },
    { label: o.submitLabel ?? "Done", run: () => submit(), primary: true },
  ];
  const grid: HTMLElement[][] = [];

  const el = h(
    "div.overlay.text-entry",
    null,
    h(
      "div.te-panel",
      null,
      h("h2", null, o.title),
      o.hint ? h("p.te-hint", null, o.hint) : null,
      field,
      keysEl,
      h("p.te-legend", null, "Ⓐ type   Ⓑ close   Ⓨ backspace   ☰ done   ·   keyboard & Ctrl+V work too"),
    ),
  );

  function render() {
    grid.length = 0;
    keysEl.replaceChildren();
    LAYOUT.forEach((line) => {
      const row = h("div.te-row");
      const btns = [...line].map((ch) => {
        const k = upper ? ch.toUpperCase() : ch;
        const b = h("button.key", { onclick: () => type(k) }, k);
        row.append(b);
        return b;
      });
      grid.push(btns);
      keysEl.append(row);
    });
    const row = h("div.te-row.special");
    grid.push(
      special.map((s) => {
        const b = h(`button.key.wide${s.primary ? ".primary" : ""}`, { onclick: s.run }, s.label);
        row.append(b);
        return b;
      }),
    );
    keysEl.append(row);
    sync();
  }

  function sync() {
    const shown = o.secret && value.length > 8 ? value.slice(0, 4) + "•".repeat(value.length - 8) + value.slice(-4) : value;
    field.replaceChildren(h("span", null, shown), h("span.caret"));
    grid.flat().forEach((b) => b.classList.remove("focused"));
    grid[r][c]?.classList.add("focused");
  }

  function type(ch: string | null) {
    cue("type");
    value = ch === null ? value.slice(0, -1) : value + ch;
    sync();
  }

  async function paste() {
    try {
      value += (await navigator.clipboard.readText()).trim();
      sync();
    } catch {
      /* clipboard denied; Ctrl+V on the keyboard still works */
    }
  }

  function submit() {
    router.closeOverlay();
    o.onSubmit(value.trim());
  }

  captureText((e) => {
    if (e.ctrlKey && e.key.toLowerCase() === "v") {
      paste();
      return true;
    }
    if (e.key === "Enter") return submit(), true;
    if (e.key === "Backspace") return type(null), true;
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) return type(e.key), true;
    return false;
  });

  render();
  router.openOverlay({
    el,
    onClose: () => captureText(null),
    onAction(e: ActionEvent) {
      switch (e.action) {
        case "up":
          r = Math.max(0, r - 1);
          break;
        case "down":
          r = Math.min(grid.length - 1, r + 1);
          break;
        case "left":
          c = Math.max(0, c - 1);
          break;
        case "right":
          c = Math.min(grid[r].length - 1, c + 1);
          break;
        case "select":
          grid[r][c]?.click();
          return true;
        case "search":
          type(null);
          return true;
        case "alt":
          type(" ");
          return true;
        case "menu":
          submit();
          return true;
        default:
          return false;
      }
      c = Math.min(c, grid[r].length - 1);
      sync();
      return true;
    },
  });
}

/** Modal yes/no choice. */
export function confirmDialog(title: string, body: string, yes: string, onYes: () => void, no = "Cancel") {
  let idx = 1;
  const btns = [
    h("button.btn", { onclick: () => (router.closeOverlay(), onYes()) }, yes),
    h("button.btn", { onclick: () => router.closeOverlay() }, no),
  ];
  const sync = () => btns.forEach((b, i) => b.classList.toggle("focused", i === idx));
  const el = h("div.overlay.dialog", null, h("div.dialog-panel", null, h("h2", null, title), h("p", null, body), h("div.btn-row", null, ...btns)));
  sync();
  router.openOverlay({
    el,
    onAction(e) {
      if (e.action === "left" || e.action === "right") idx = e.action === "left" ? 0 : 1;
      else if (e.action === "select") btns[idx].click();
      else return false;
      sync();
      return true;
    },
  });
}
