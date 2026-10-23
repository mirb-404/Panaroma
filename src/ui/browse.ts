// The browse surface used by every list screen: a vertical stack of rows, each
// either a horizontally-scrolling shelf or a static grid row. Focus is spatial,
// each shelf remembers its position, and all scrolling is spring-driven
// transforms (no layout per frame).
import * as api from "../api";
import { ApiError, type Item, type Video } from "../api";
import { decodeEntities, h, icon } from "../dom";
import { pointerIsActive, type ActionEvent } from "../input";
import { Spring } from "../motion";
import { edgeBump, type Screen } from "../router";
import { openItem } from "../routes";
import { cue } from "../sound";
import { card, loadCardImage, skeletonCards, type CardEl } from "./card";
import { setBackdrop } from "./chrome";
import { cancelPreview, previewTime, schedulePreview, takePreview } from "./preview";

export interface RowSpec {
  title: string;
  load: () => Promise<Item[]>;
  /** "grid" rows are produced by chunking; they don't scroll horizontally. */
  layout?: "shelf" | "grid";
  size?: "normal" | "large";
}

export interface BrowseOptions {
  /** Show the big focused-item header + cinematic backdrop. */
  hero?: boolean;
  /** Static content above the rows (e.g. a channel header). */
  header?: HTMLElement;
  rows: RowSpec[];
  /** Shown when every row is empty or failed. */
  empty?: (err: unknown, youtubePath?: string) => { el: HTMLElement; onAction(e: ActionEvent): boolean };
  /** The equivalent youtube.com page, offered as a fallback when loading fails. */
  youtubePath?: string;
  onFocusItem?: (item: Item) => void;
  /** Adds a Refresh button (and Ⓧ / X): drops cached feeds, then every row reloads. */
  refresh?: () => Promise<void>;
}

interface Row {
  el: HTMLElement;
  track: HTMLElement;
  cards: CardEl[];
  items: Item[];
  idx: number;
  scroll: Spring;
  grid: boolean;
  stride: number;
  /** For grid rows: the index of the row's first item in the full list. */
  offset: number;
  source: RowSpec;
}

export class BrowseView implements Screen {
  el: HTMLElement;
  private rowsEl: HTMLElement;
  private viewport: HTMLElement;
  private rows: Row[] = [];
  private r = 0;
  private vscroll: Spring;
  private heroEl?: HTMLElement;
  private heroTimer = 0;
  private emptyPanel?: { el: HTMLElement; onAction(e: ActionEvent): boolean };
  private pending = 0;
  private visible = true;
  private resizeObs: ResizeObserver;
  private focusedEl?: HTMLElement;
  private prefetchTimer = 0;
  /** Card currently hovered for an in-card preview (non-hero screens). */
  private previewHost?: HTMLElement;
  /** Bumped by a refresh, so rows still loading from before it are ignored. */
  private gen = 0;
  private refreshBtn?: HTMLButtonElement;
  private refreshFocused = false;

  constructor(private opts: BrowseOptions) {
    this.rowsEl = h("div.rows");
    this.viewport = h("div.rows-viewport", null, this.rowsEl);
    this.el = h(`section.screen.browse${opts.hero ? ".with-hero" : ""}`);
    if (opts.hero) {
      this.heroEl = h("div.hero-meta");
      this.el.append(this.heroEl);
    }
    if (opts.header) this.rowsEl.append(opts.header);
    this.el.append(this.viewport);
    if (opts.refresh) {
      this.refreshBtn = h(
        "button.browse-refresh",
        { title: "Refresh: ▲ then Ⓐ, or Ⓧ / X", onclick: () => void this.refresh() },
        icon("refresh", "icon browse-refresh-icon"),
        h("span", null, "Refresh"),
      );
      this.el.append(this.refreshBtn);
    }
    this.vscroll = new Spring(0, (y) => (this.rowsEl.style.transform = `translate3d(0,${-y}px,0)`), 220, 29);
    this.resizeObs = new ResizeObserver(() => this.relayout());
    this.resizeObs.observe(this.viewport);
    this.build();
  }

  /** New or different videos: forget the cached feeds and load every row again. */
  private async refresh() {
    if (!this.opts.refresh || this.refreshBtn?.classList.contains("busy")) return;
    this.refreshBtn?.classList.add("busy");
    cue("toggleOn");
    cancelPreview();
    await this.opts.refresh().catch(() => {});
    this.gen++;
    // Focus lands on the first new video.
    this.refreshFocused = false;
    this.refreshBtn?.classList.remove("focused");
    for (const row of this.rows) row.el.remove();
    this.rows = [];
    this.r = 0;
    this.pending = 0;
    this.lastErr = undefined;
    this.focusedEl = undefined;
    this.emptyPanel?.el.remove();
    this.emptyPanel = undefined;
    this.vscroll.to(0);
    this.build();
    this.syncFocus(true);
  }

  private build() {
    for (const spec of this.opts.rows) {
      if (spec.layout === "grid") this.loadGrid(spec);
      else this.addShelf(spec);
    }
  }

  private makeRow(spec: RowSpec, title: string | null, grid: boolean): Row {
    const track = h("div.track");
    const viewport = h("div.track-viewport", null, track);
    const el = h(
      `div.row${grid ? ".grid-row" : ""}${spec.size === "large" ? ".large" : ""}`,
      null,
      title ? h("h3.row-title", null, title) : null,
      viewport,
    );
    const row: Row = {
      el, track, cards: [], items: [], idx: 0, grid, stride: 0, offset: 0, source: spec,
      scroll: new Spring(0, (x) => (track.style.transform = `translate3d(${-x}px,0,0)`), 260, 31),
    };
    // Mouse paging: shelves only move when these are clicked, never on hover.
    if (!grid)
      viewport.append(
        h("button.row-page.prev", { onclick: () => this.page(row, -1), "aria-label": "Previous" }, icon("back")),
        h("button.row-page.next", { onclick: () => this.page(row, 1), "aria-label": "Next" }, icon("next")),
      );
    return row;
  }

  /** Moves a shelf by one screenful (mouse arrows at the row's ends). */
  private page(row: Row, dir: -1 | 1) {
    if (!row.cards.length) return;
    this.measure(row);
    const vw = (row.track.parentElement as HTMLElement).clientWidth;
    const step = Math.max(1, Math.floor(vw / (row.stride || 1)) - 1);
    const next = Math.max(0, Math.min(row.cards.length - 1, row.idx + dir * step));
    if (next === row.idx) return edgeBump();
    cue("move");
    row.idx = next;
    this.r = this.rows.indexOf(row);
    this.syncFocus();
  }

  private addShelf(spec: RowSpec) {
    const row = this.makeRow(spec, spec.title, false);
    row.track.append(...skeletonCards(8));
    row.el.classList.add("loading");
    this.rows.push(row);
    this.rowsEl.append(row.el);
    this.pending++;
    const gen = this.gen;
    spec
      .load()
      .then((items) => {
        if (gen !== this.gen) return;
        if (!items.length) return this.removeRow(row);
        this.fill(row, items);
      })
      .catch((err) => gen === this.gen && this.fail(row, err))
      .finally(() => gen === this.gen && this.settle());
    if (this.rows.length === 1) this.syncFocus();
  }

  private loadGrid(spec: RowSpec) {
    // Placeholder row until we know how many columns/items there are.
    const ph = this.makeRow(spec, spec.title, true);
    ph.track.append(...skeletonCards(this.columns()));
    ph.el.classList.add("loading");
    this.rows.push(ph);
    this.rowsEl.append(ph.el);
    this.pending++;
    const gen = this.gen;
    spec
      .load()
      .then((items) => {
        if (gen !== this.gen) return;
        const at = this.rows.indexOf(ph);
        if (at < 0) return;
        const cols = this.columns();
        const chunks: Row[] = [];
        for (let i = 0; i < items.length; i += cols) {
          const row = this.makeRow(spec, i === 0 ? spec.title : null, true);
          row.offset = i;
          chunks.push(row);
          this.fill(row, items.slice(i, i + cols), items);
        }
        ph.el.replaceWith(...chunks.map((c) => c.el));
        this.rows.splice(at, 1, ...chunks);
        if (this.r > at) this.r += chunks.length - 1;
        if (!chunks.length) this.r = Math.min(this.r, Math.max(0, this.rows.length - 1));
        this.syncFocus(true);
      })
      .catch((err) => gen === this.gen && this.fail(ph, err))
      .finally(() => gen === this.gen && this.settle());
  }

  /** Columns for grid rows, derived from the live card width. */
  private columns(): number {
    const css = getComputedStyle(document.documentElement);
    const rem = parseFloat(css.fontSize) || 20;
    const cardW = 17.5 * rem + 1.4 * rem;
    const avail = (this.viewport.clientWidth || window.innerWidth) - 2 * rem;
    return Math.max(2, Math.floor(avail / cardW));
  }

  private fill(row: Row, items: Item[], queueSource?: Item[]) {
    row.items = items;
    row.cards = items.map((it, i) =>
      card(it, () => {
        // Mouse: first click focuses, second opens (TV semantics stay intact).
        const ri = this.rows.indexOf(row);
        if (ri === this.r && row.idx === i) this.open(row, i, queueSource);
        else {
          this.r = ri;
          row.idx = i;
          this.syncFocus();
        }
      }),
    );
    // Mouse hover previews (controller focus previews are started in syncFocus).
    row.cards.forEach((c, i) => {
      const it = items[i];
      if (it.kind !== "video") return;
      // "mousemove", not "mouseenter": enter fires before the move is recorded,
      // and it also fires when cards slide under a resting cursor during
      // controller scrolling, which would make focus jump back.
      c.addEventListener("mousemove", () => {
        if (!this.visible || !pointerIsActive()) return;
        if (this.opts.hero) {
          // Hero screens: hovering focuses the card, so the hero (title +
          // preview) always describes what's under the pointer. The rows only
          // scroll as far as needed to reveal it: re-pinning the hovered card
          // to the edge would slide the next card under the pointer, which
          // would then be focused in turn, and the row would run away.
          // Only cards that are fully on screen take focus from the pointer:
          // focusing a half-visible card at either end scrolled the row,
          // sliding the next card under the cursor, so a resting mouse at the
          // edge cycled through the whole shelf.
          if (!this.fullyVisible(c)) return;
          const ri = this.rows.indexOf(row);
          if (ri >= 0 && (ri !== this.r || row.idx !== i)) {
            this.r = ri;
            row.idx = i;
            this.syncFocus(false, true);
          }
        } else if (!this.previewHost || this.previewHost !== c) {
          this.previewHost = c;
          schedulePreview(it.id, c.querySelector(".thumb")!);
        }
      });
      if (!this.opts.hero)
        c.addEventListener("mouseleave", () => {
          this.previewHost = undefined;
          cancelPreview();
        });
    });
    row.track.replaceChildren(...row.cards);
    row.el.classList.remove("loading");
    row.stride = 0;
    row.idx = Math.min(row.idx, items.length - 1);
    this.syncFocus(true);
  }

  private fullyVisible(c: HTMLElement): boolean {
    const r = c.getBoundingClientRect();
    const tv = c.closest(".track-viewport")!.getBoundingClientRect();
    const vv = this.viewport.getBoundingClientRect();
    return r.left >= tv.left - 1 && r.right <= tv.right + 1 && r.top >= vv.top - 1 && r.bottom <= vv.bottom + 1;
  }

  private fail(row: Row, err: unknown) {
    console.warn("row failed", row.source.title, err);
    this.removeRow(row, err);
  }

  private lastErr: unknown;
  private removeRow(row: Row, err?: unknown) {
    if (err) this.lastErr = err;
    const at = this.rows.indexOf(row);
    if (at < 0) return;
    this.rows.splice(at, 1);
    row.el.remove();
    if (this.r >= at && this.r > 0) this.r--;
    this.syncFocus(true);
  }

  private settle() {
    if (--this.pending <= 0) this.refreshBtn?.classList.remove("busy");
    if (this.pending > 0 || this.rows.length) return;
    const err = this.lastErr ?? new ApiError("Nothing here yet", 0, "empty");
    if (this.opts.empty) {
      this.emptyPanel = this.opts.empty(err, this.opts.youtubePath);
      this.el.append(this.emptyPanel.el);
      this.heroEl?.replaceChildren();
    }
  }

  private open(row: Row, i: number, queueSource?: Item[]) {
    const all = queueSource ?? row.items;
    const at = row.offset + i;
    const item = row.items[i];
    const queue = all.slice(at).filter((x): x is Video => x.kind === "video");
    // Netflix-style: hand the playing preview to the player (seamless), or at
    // least continue from where the preview got to.
    if (item.kind === "video") openItem(item, queue, previewTime(item.id), takePreview(item.id) ?? undefined);
    else openItem(item, queue);
  }

  // ---- focus & motion ------------------------------------------------------------

  private get row(): Row | undefined {
    return this.rows[this.r];
  }

  private measure(row: Row) {
    if (row.stride || !row.cards.length) return;
    const a = row.cards[0];
    const b = row.cards[1];
    row.stride = b ? b.offsetLeft - a.offsetLeft : a.offsetWidth;
  }

  /** Horizontal padding of the track (room for the focus scale-up), both sides. */
  private trackPad(row: Row): number {
    const cs = getComputedStyle(row.track);
    return parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  }

  private relayout() {
    for (const row of this.rows) row.stride = 0;
    this.syncFocus(true);
  }

  /** `reveal`: pointer focus — scroll only enough to bring the card into view. */
  private syncFocus(snap = false, reveal = false) {
    this.rows.forEach((row, i) => row.el.classList.toggle("active", i === this.r));
    const row = this.row;
    const c = row?.cards[row.idx];
    // The pointer on a card takes focus back from Refresh.
    if (reveal && this.refreshFocused) {
      this.refreshFocused = false;
      this.refreshBtn?.classList.remove("focused");
    }
    if (c !== this.focusedEl) {
      this.focusedEl?.classList.remove("focused");
      c?.classList.add("focused");
      this.focusedEl = c;
    }
    if (this.refreshFocused) c?.classList.remove("focused");
    if (!row) return;

    // Horizontal: pin the focused card to the left edge, clamped at the end.
    if (!row.grid) {
      this.measure(row);
      const vw = (row.track.parentElement as HTMLElement).clientWidth;
      const contentW = (row.cards.length - 1) * row.stride + (row.cards[0]?.offsetWidth ?? 0) + this.trackPad(row);
      const max = Math.max(0, contentW - vw);
      let x = row.idx * row.stride;
      if (reveal && c) {
        const cur = row.scroll.target;
        const right = x + c.offsetWidth + this.trackPad(row);
        x = x < cur ? x : right > cur + vw ? right - vw : cur;
      }
      x = Math.min(x, max);
      if (snap && !this.visible) row.scroll.snap(x);
      else row.scroll.to(x);
    }

    // Vertical: active row aligned to the top of the rows viewport (hero mode) or
    // kept ~30% down (lists), clamped to content.
    const anchor = this.opts.hero ? 0 : this.viewport.clientHeight * 0.28;
    const contentH = this.rowsEl.scrollHeight;
    const maxY = Math.max(0, contentH - this.viewport.clientHeight + 40);
    let y = Math.max(0, row.el.offsetTop - anchor);
    if (!this.opts.hero) y = Math.min(y, maxY);
    if (this.r === 0 && !this.opts.hero) y = 0;
    if (reveal) {
      const cur = this.vscroll.target;
      const top = row.el.offsetTop;
      const bottom = top + row.el.offsetHeight;
      const vh = this.viewport.clientHeight;
      y = top < cur ? top : bottom > cur + vh ? bottom - vh : cur;
    }
    this.vscroll.to(y);

    this.loadNearbyImages();
    const item = row.items[row.idx];
    if (item) this.focusItem(item);
    // Resting focus on a video previews it, like hovering does.
    if (this.visible && c && item?.kind === "video" && !this.el.closest(".inactive")) {
      schedulePreview(item.id, this.opts.hero ? undefined : c.querySelector(".thumb")!);
      clearTimeout(this.prefetchTimer);
      this.prefetchTimer = window.setTimeout(() => api.watchNext(item.id).catch(() => {}), 400);
    }
    else cancelPreview();
  }

  private loadNearbyImages() {
    for (let ri = Math.max(0, this.r - 1); ri <= Math.min(this.rows.length - 1, this.r + 3); ri++) {
      const row = this.rows[ri];
      const from = Math.max(0, row.idx - 2);
      const to = Math.min(row.cards.length, row.idx + (row.grid ? row.cards.length : 12));
      for (let i = from; i < to; i++) loadCardImage(row.cards[i]);
    }
  }

  private focusItem(item: Item) {
    this.opts.onFocusItem?.(item);
    if (!this.heroEl || !this.visible) return;
    setBackdrop(item.kind === "channel" ? (item.banner ?? item.avatar) : item.thumbLarge);
    clearTimeout(this.heroTimer);
    this.heroTimer = window.setTimeout(() => this.renderHero(item), 90);
  }

  private renderHero(item: Item) {
    const hero = this.heroEl!;
    let line: string[];
    let desc = "";
    if (item.kind === "video") {
      line = [item.channelTitle, item.viewsText, item.ageText, item.live ? "LIVE" : item.durationText];
      desc = item.description;
    } else if (item.kind === "channel") {
      line = [item.subscribersText, item.videosText];
      desc = item.description;
    } else {
      line = [item.channelTitle, item.countText];
    }
    const next = h(
      "div.hero-inner",
      null,
      h("h1.hero-title", null, decodeEntities(item.title)),
      h("div.hero-line", null, line.filter(Boolean).join("  ·  ")),
      desc ? h("p.hero-desc", null, desc.split("\n").slice(0, 4).join(" ")) : null,
    );
    hero.replaceChildren(next);
    next.animate([{ opacity: 0, translate: "0 0.4rem" }, { opacity: 1, translate: "0 0" }], {
      duration: 260,
      easing: "cubic-bezier(.2,.8,.2,1)",
    });
  }

  onShow() {
    this.visible = true;
    this.syncFocus(true);
    const item = this.row?.items[this.row.idx];
    if (!this.opts.hero) setBackdrop(null);
    else if (item) this.focusItem(item);
  }

  onHide() {
    this.visible = false;
    cancelPreview();
  }

  onDestroy() {
    this.resizeObs.disconnect();
  }

  /** ▲ from the first row lands on Refresh; Ⓐ there refreshes, ▼ goes back. */
  private setRefreshFocus(on: boolean) {
    this.refreshFocused = on;
    this.refreshBtn?.classList.toggle("focused", on);
    this.focusedEl?.classList.toggle("focused", !on);
    cue("move");
  }

  onAction(e: ActionEvent): boolean {
    if (e.action === "alt" && this.opts.refresh) {
      if (!e.repeat) void this.refresh();
      return true;
    }
    if (this.refreshFocused) {
      if (e.action === "select") {
        if (!e.repeat) void this.refresh();
      } else if (e.action === "down") this.setRefreshFocus(false);
      else if (e.action === "left") {
        this.setRefreshFocus(false);
        return false;
      } else return e.action === "up" || e.action === "right";
      return true;
    }
    if (e.action === "up" && this.refreshBtn && this.r === 0 && !e.repeat) {
      this.setRefreshFocus(true);
      return true;
    }
    if (this.emptyPanel && !this.rows.length) return this.emptyPanel.onAction(e);
    const row = this.row;
    if (!row) return false;
    switch (e.action) {
      case "left":
        if (row.idx === 0) return false;
        row.idx--;
        break;
      case "right":
        if (row.idx >= row.cards.length - 1) {
          if (!e.repeat) edgeBump();
          return true;
        }
        row.idx++;
        break;
      case "up":
      case "down": {
        const nr = this.r + (e.action === "down" ? 1 : -1);
        if (nr < 0) return false; // let the parent screen take focus upward
        if (nr >= this.rows.length) {
          if (!e.repeat) edgeBump();
          return true;
        }
        const target = this.rows[nr];
        // Grid → grid keeps the column; shelves restore their remembered index.
        if (row.grid && target.grid) target.idx = Math.min(row.idx, target.cards.length - 1);
        this.r = nr;
        break;
      }
      case "select":
        if (row.cards.length) this.open(row, row.idx, row.grid ? this.gridItems(row) : undefined);
        return true;
      default:
        return false;
    }
    this.syncFocus();
    return true;
  }

  /** All items of the grid a row belongs to, for building the play queue. */
  private gridItems(row: Row): Item[] {
    return this.rows.filter((r) => r.grid && r.source === row.source).flatMap((r) => r.items);
  }
}
