// The browse surface used by every list screen: a vertical stack of rows, each
// either a horizontally-scrolling shelf or a static grid row. Focus is spatial,
// each shelf remembers its position, and all scrolling is spring-driven
// transforms (no layout per frame).
import { ApiError, type Item, type Video } from "../api";
import { decodeEntities, fmtAge, fmtCount, fmtDuration, h } from "../dom";
import type { ActionEvent } from "../input";
import { Spring } from "../motion";
import { edgeBump, type Screen } from "../router";
import { openItem } from "../routes";
import { card, loadCardImage, skeletonCards, type CardEl } from "./card";
import { setBackdrop } from "./chrome";

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
  empty?: (err: unknown) => { el: HTMLElement; onAction(e: ActionEvent): boolean };
  onFocusItem?: (item: Item) => void;
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
    this.vscroll = new Spring(0, (y) => (this.rowsEl.style.transform = `translate3d(0,${-y}px,0)`), 220, 29);
    this.resizeObs = new ResizeObserver(() => this.relayout());
    this.resizeObs.observe(this.viewport);
    this.build();
  }

  private build() {
    for (const spec of this.opts.rows) {
      if (spec.layout === "grid") this.loadGrid(spec);
      else this.addShelf(spec);
    }
  }

  private makeRow(spec: RowSpec, title: string | null, grid: boolean): Row {
    const track = h("div.track");
    const el = h(
      `div.row${grid ? ".grid-row" : ""}${spec.size === "large" ? ".large" : ""}`,
      null,
      title ? h("h3.row-title", null, title) : null,
      h("div.track-viewport", null, track),
    );
    const row: Row = {
      el, track, cards: [], items: [], idx: 0, grid, stride: 0, offset: 0, source: spec,
      scroll: new Spring(0, (x) => (track.style.transform = `translate3d(${-x}px,0,0)`), 260, 31),
    };
    return row;
  }

  private addShelf(spec: RowSpec) {
    const row = this.makeRow(spec, spec.title, false);
    row.track.append(...skeletonCards(8));
    row.el.classList.add("loading");
    this.rows.push(row);
    this.rowsEl.append(row.el);
    this.pending++;
    spec
      .load()
      .then((items) => {
        if (!items.length) return this.removeRow(row);
        this.fill(row, items);
      })
      .catch((err) => this.fail(row, err))
      .finally(() => this.settle());
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
    spec
      .load()
      .then((items) => {
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
      .catch((err) => this.fail(ph, err))
      .finally(() => this.settle());
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
    row.track.replaceChildren(...row.cards);
    row.el.classList.remove("loading");
    row.stride = 0;
    row.idx = Math.min(row.idx, items.length - 1);
    this.syncFocus(true);
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
    if (--this.pending > 0 || this.rows.length) return;
    const err = this.lastErr ?? new ApiError("Nothing here yet", 0, "empty");
    if (this.opts.empty) {
      this.emptyPanel = this.opts.empty(err);
      this.el.append(this.emptyPanel.el);
      this.heroEl?.replaceChildren();
    }
  }

  private open(row: Row, i: number, queueSource?: Item[]) {
    const all = queueSource ?? row.items;
    const at = row.offset + i;
    const item = row.items[i];
    const queue = all.slice(at).filter((x): x is Video => x.kind === "video");
    openItem(item, queue);
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

  private syncFocus(snap = false) {
    this.rows.forEach((row, i) => row.el.classList.toggle("active", i === this.r));
    const row = this.row;
    const c = row?.cards[row.idx];
    if (c !== this.focusedEl) {
      this.focusedEl?.classList.remove("focused");
      c?.classList.add("focused");
      this.focusedEl = c;
    }
    if (!row) return;

    // Horizontal: pin the focused card to the left edge, clamped at the end.
    if (!row.grid) {
      this.measure(row);
      const vw = (row.track.parentElement as HTMLElement).clientWidth;
      const contentW = (row.cards.length - 1) * row.stride + (row.cards[0]?.offsetWidth ?? 0) + this.trackPad(row);
      const max = Math.max(0, contentW - vw);
      const x = Math.min(row.idx * row.stride, max);
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
    this.vscroll.to(y);

    this.loadNearbyImages();
    const item = row.items[row.idx];
    if (item) this.focusItem(item);
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
      line = [item.channelTitle, fmtCount(item.views, "view"), fmtAge(item.publishedAt), item.live ? "LIVE" : fmtDuration(item.durationSec)];
      desc = item.description;
    } else if (item.kind === "channel") {
      line = [fmtCount(item.subscribers, "subscriber")];
      desc = item.description;
    } else {
      line = [item.channelTitle, item.count !== undefined ? `${item.count} videos` : ""];
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
  }

  onDestroy() {
    this.resizeObs.disconnect();
  }

  onAction(e: ActionEvent): boolean {
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
