import * as api from "../api";
import { h, icon } from "../dom";
import type { ActionEvent } from "../input";
import type { Screen } from "../router";
import { settings, updateSettings } from "../settings";
import { BrowseView } from "../ui/browse";
import { setBackdrop } from "../ui/chrome";
import { openTextEntry } from "../ui/textentry";
import { errorPanel } from "./common";

/** Search: a query bar (field + recent queries) above a results grid. */
export function searchScreen(): Screen {
  let query = "";
  let results: BrowseView | null = null;
  let zone: "bar" | "results" = "bar";
  let idx = 0;

  const field = h("button.search-field", { onclick: () => edit() }, icon("search"), h("span"));
  const chips = h("div.chips");
  const bar = h("div.search-bar", null, field, chips);
  const host = h("div.search-results");
  const el = h("section.screen.search-screen", null, bar, host);

  const barItems = () => [field, ...chips.children] as HTMLElement[];

  function renderBar() {
    field.querySelector("span")!.textContent = query || "Search YouTube";
    field.classList.toggle("placeholder", !query);
    chips.replaceChildren(
      ...settings()
        .searchHistory.slice(0, 8)
        .map((q) => h("button.chip", { onclick: () => run(q) }, q)),
    );
    sync();
  }

  function sync() {
    barItems().forEach((b, i) => b.classList.toggle("focused", zone === "bar" && i === idx));
    host.classList.toggle("inactive", zone === "bar");
  }

  function edit() {
    openTextEntry({ title: "Search", value: query, submitLabel: "Search", onSubmit: (q) => q && run(q) });
  }

  function run(q: string) {
    query = q;
    const hist = [q, ...settings().searchHistory.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 12);
    updateSettings({ searchHistory: hist });
    results?.onDestroy();
    results = new BrowseView({
      rows: [{ title: `Results for “${q}”`, layout: "grid", load: () => api.search(q) }],
      empty: errorPanel,
    });
    host.replaceChildren(results.el);
    results.onShow();
    zone = "results";
    idx = 0;
    renderBar();
  }

  renderBar();

  return {
    el,
    onShow() {
      setBackdrop(null);
      results?.onShow();
    },
    onHide: () => results?.onHide(),
    onAction(e: ActionEvent) {
      if (e.action === "search") {
        edit();
        return true;
      }
      if (zone === "results" && results) {
        if (results.onAction(e)) return true;
        if (e.action === "up") {
          zone = "bar";
          sync();
          return true;
        }
        return false;
      }
      const n = barItems().length;
      switch (e.action) {
        case "left":
          if (idx === 0) return false;
          idx--;
          break;
        case "right":
          idx = Math.min(n - 1, idx + 1);
          break;
        case "down":
          if (!results) return false;
          zone = "results";
          break;
        case "select":
          barItems()[idx]?.click();
          return true;
        default:
          return false;
      }
      sync();
      return true;
    },
  };
}
