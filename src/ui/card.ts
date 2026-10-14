import type { Item } from "../api";
import { decodeEntities, h } from "../dom";

export interface CardEl extends HTMLElement {
  _img?: HTMLImageElement;
  _src?: string;
}

export function card(item: Item, onClick: () => void): CardEl {
  let el: CardEl;
  if (item.kind === "channel") {
    el = h(
      "div.card.card-channel",
      { onclick: onClick },
      h("div.thumb.round", null, h("img", { alt: "", decoding: "async", draggable: "false", referrerpolicy: "no-referrer" })),
      h("div.meta", null, h("div.title", null, decodeEntities(item.title)), h("div.sub", null, item.subscribersText)),
    );
    el._src = item.avatar;
  } else if (item.kind === "playlist") {
    el = h(
      "div.card.card-playlist",
      { onclick: onClick },
      h(
        "div.thumb",
        null,
        h("img", { alt: "", decoding: "async", draggable: "false" }),
        h("div.stack-badge", null, item.countText || "Playlist"),
      ),
      h("div.meta", null, h("div.title", null, decodeEntities(item.title)), h("div.sub", null, item.channelTitle)),
    );
    el._src = item.thumb;
  } else {
    const badge = item.live
      ? h("span.badge.live", null, "LIVE")
      : item.durationText
        ? h("span.badge", null, item.durationText)
        : null;
    el = h(
      "div.card",
      { onclick: onClick },
      h("div.thumb", null, h("img", { alt: "", decoding: "async", draggable: "false" }), badge),
      h(
        "div.meta",
        null,
        h("div.title", null, decodeEntities(item.title)),
        h("div.sub", null, [item.channelTitle, item.viewsText, item.ageText].filter(Boolean).join(" · ")),
      ),
    );
    el._src = item.thumb;
  }
  el._img = el.querySelector("img")!;
  return el;
}

/** Attaches the thumbnail on demand; called only for cards near the viewport. */
export function loadCardImage(el: CardEl) {
  const img = el._img;
  if (!img || !el._src || img.src) return;
  img.onload = () => img.classList.add("loaded");
  img.src = el._src;
}

export function skeletonCards(n: number): HTMLElement[] {
  return Array.from({ length: n }, () => h("div.card.skeleton", null, h("div.thumb"), h("div.meta", null, h("div.title"), h("div.sub"))));
}
