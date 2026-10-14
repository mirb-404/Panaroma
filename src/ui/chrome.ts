// App-wide chrome: the cinematic backdrop, the navigation rail, toasts and the clock.
import { h, icon } from "../dom";
import type { ActionEvent } from "../input";
import { router, TABS, type TabId } from "../router";
import { settings } from "../settings";
import { cue } from "../sound";

// ---- backdrop ------------------------------------------------------------------
// Two stacked layers; the incoming image is fully decoded off-thread before it
// fades in, so fast scrolling never shows a half-painted frame.

const layers = [h("img.backdrop-img", { alt: "" }), h("img.backdrop-img", { alt: "" })];
let front = 0;
let wanted = "";
let timer = 0;

export const backdropEl = h("div.backdrop", null, ...layers, h("div.backdrop-shade"));

export function setBackdrop(url: string | null, immediate = false) {
  url ??= "";
  if (url === wanted) return;
  wanted = url;
  clearTimeout(timer);
  timer = window.setTimeout(() => swap(url), immediate ? 0 : 140);
}

async function swap(url: string) {
  const back = layers[1 - front];
  if (!url) {
    layers[front].classList.remove("shown");
    return;
  }
  back.src = url;
  let ok = true;
  try {
    await back.decode();
  } catch {
    ok = false;
  }
  // maxres thumbnails don't exist for every video; YouTube then serves a 120×90
  // grey placeholder (or an error). Fall back to the always-present hq version.
  if ((!ok || back.naturalWidth <= 120) && url.includes("maxresdefault")) {
    if (wanted === url) {
      wanted = "";
      setBackdrop(url.replace("maxresdefault", "hqdefault"), true);
    }
    return;
  }
  if (url !== wanted) return;
  back.classList.add("shown");
  layers[front].classList.remove("shown");
  front = 1 - front;
}

// ---- rail ---------------------------------------------------------------------

const LABELS: Record<TabId, [string, Parameters<typeof icon>[0]]> = {
  home: ["Home", "home"],
  subs: ["Subscriptions", "subs"],
  search: ["Search", "search"],
  library: ["Library", "library"],
  settings: ["Settings", "settings"],
};

export function createRail() {
  let idx = 0;
  let switchTimer = 0;
  const switchSoon = () => {
    clearTimeout(switchTimer);
    switchTimer = window.setTimeout(() => router.showTab(TABS[idx]), 260);
  };
  const items = TABS.map((t, i) =>
    h(
      "button.rail-item",
      {
        onclick: () => {
          idx = i;
          router.showTab(t);
          router.focusRail(false);
        },
      },
      icon(LABELS[t][1]),
      h("span.rail-label", null, LABELS[t][0]),
    ),
  );
  const avatarImg = h("img.rail-avatar-img", { alt: "", referrerpolicy: "no-referrer", draggable: "false" });
  const avatar = h("div.rail-avatar", { title: "Google account" }, icon("user", "icon rail-avatar-icon"), avatarImg);
  avatarImg.onload = () => avatar.classList.add("has");
  avatarImg.onerror = () => avatar.classList.remove("has");
  const el = h(
    "nav.rail",
    null,
    h("div.rail-logo", null, h("span.logo-mark"), h("span.rail-label.logo-text", null, "Panorama")),
    h("div.rail-items", null, ...items),
    avatar,
  );
  const sync = () => items.forEach((b, i) => b.classList.toggle("focused", router.railFocused && i === idx));

  return {
    el,
    setAvatar(url: string | null) {
      if (!url) {
        avatar.classList.remove("has");
        avatarImg.removeAttribute("src");
      } else if (avatarImg.getAttribute("src") !== url) avatarImg.src = url;
    },
    setActive(t: TabId) {
      idx = TABS.indexOf(t);
      items.forEach((b) => b.classList.toggle("active", b === items[TABS.indexOf(t)]));
      sync();
    },
    setFocused(on: boolean) {
      el.classList.toggle("open", on);
      sync();
    },
    onAction(e: ActionEvent): boolean {
      switch (e.action) {
        case "up":
          idx = Math.max(0, idx - 1);
          switchSoon();
          break;
        case "down":
          idx = Math.min(TABS.length - 1, idx + 1);
          switchSoon();
          break;
        case "right":
        case "select":
          clearTimeout(switchTimer);
          if (router.tab !== TABS[idx]) router.showTab(TABS[idx]);
          router.focusRail(false);
          break;
        default:
          return false;
      }
      sync();
      return true;
    },
  };
}

// ---- toasts ---------------------------------------------------------------------

export const toastHost = h("div.toasts");

export function toast(text: string, kind: "info" | "error" | "success" = "info", ms = 3200) {
  cue(kind === "error" ? "error" : kind === "success" ? "success" : "toast");
  const t = h(`div.toast.${kind}`, null, text);
  toastHost.append(t);
  setTimeout(() => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 300);
  }, ms);
}

// ---- clock --------------------------------------------------------------------

export function createClock() {
  const el = h("div.clock");
  const fmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const tick = () => {
    el.textContent = fmt.format(new Date());
    setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50);
  };
  tick();
  return el;
}

/** Root font size scales with window height so layouts are resolution-independent. */
export function applyScale() {
  // 20px at 1080p. Height drives the scale (TV-style); width caps it so 4:3,
  // portrait and small windows don't overflow horizontally.
  const base = Math.min(window.innerHeight / 54, window.innerWidth / 72);
  document.documentElement.style.fontSize = `${Math.max(12, base * settings().uiScale)}px`;
  document.documentElement.classList.toggle("reduced-motion", settings().reducedMotion);
  const ratio = window.innerWidth / window.innerHeight;
  document.documentElement.dataset.aspect = ratio >= 3.2 ? "super" : ratio >= 2.2 ? "ultra" : "wide";
}
