// Screen stack + tab roots. Root tabs stay alive (so returning to Home keeps the
// exact row/card you left), pushed screens animate over them and are destroyed
// when popped. All input flows: overlay → rail (if focused) → top screen → router.
import { h } from "./dom";
import { rumble, setActionHandler, type ActionEvent } from "./input";
import { settings } from "./settings";

export interface Screen {
  el: HTMLElement;
  /** Return true if the action was consumed. */
  onAction(e: ActionEvent): boolean;
  onShow?(): void;
  onHide?(): void;
  onDestroy?(): void;
  /** Pushed screens that cover the whole window (the player). */
  immersive?: boolean;
}

export interface Overlay {
  el: HTMLElement;
  onAction(e: ActionEvent): boolean;
  onClose?(): void;
}

export type TabId = "home" | "subs" | "search" | "library" | "settings";
export const TABS: TabId[] = ["home", "subs", "search", "library", "settings"];

interface RailApi {
  el: HTMLElement;
  setActive(t: TabId): void;
  setFocused(on: boolean): void;
  onAction(e: ActionEvent): boolean;
}

class Router {
  stage!: HTMLElement;
  overlayHost!: HTMLElement;
  rail!: RailApi;
  private factories = {} as Record<TabId, () => Screen>;
  private roots = new Map<TabId, Screen>();
  private stack: Screen[] = [];
  private overlays: Overlay[] = [];
  tab: TabId = "home";
  railFocused = false;
  onGlobal: (e: ActionEvent) => boolean = () => false;

  init(stage: HTMLElement, overlayHost: HTMLElement, rail: RailApi, factories: Record<TabId, () => Screen>) {
    this.stage = stage;
    this.overlayHost = overlayHost;
    this.rail = rail;
    this.factories = factories;
    setActionHandler((e) => this.dispatch(e));
  }

  get top(): Screen | undefined {
    return this.stack[this.stack.length - 1] ?? this.roots.get(this.tab);
  }

  private dispatch(e: ActionEvent) {
    const overlay = this.overlays[this.overlays.length - 1];
    if (overlay) {
      if (!overlay.onAction(e) && e.action === "back") this.closeOverlay();
      return;
    }
    if (this.onGlobal(e)) return;
    if (this.railFocused && !this.stack.length) {
      this.rail.onAction(e);
      return;
    }
    if (this.top?.onAction(e)) return;

    switch (e.action) {
      case "back":
        if (this.stack.length) this.pop();
        else this.focusRail(true);
        return;
      case "left":
        if (!this.stack.length) this.focusRail(true);
        else edgeBump();
        return;
      case "prevTab":
      case "nextTab":
        if (!this.stack.length) {
          const i = TABS.indexOf(this.tab) + (e.action === "nextTab" ? 1 : -1);
          this.showTab(TABS[(i + TABS.length) % TABS.length]);
        }
        return;
      case "search":
        if (!this.stack.length && this.tab !== "search") {
          this.showTab("search");
          this.top?.onAction(e); // opens the keyboard
        }
        return;
      default:
        if (!e.repeat && ["up", "down", "right"].includes(e.action)) edgeBump();
    }
  }

  focusRail(on: boolean) {
    if (this.stack.length) on = false;
    this.railFocused = on;
    this.rail.setFocused(on);
    document.body.classList.toggle("rail-open", on);
  }

  showTab(t: TabId) {
    while (this.stack.length) this.pop(true);
    const prev = this.roots.get(this.tab);
    let next = this.roots.get(t);
    if (!next) {
      next = this.factories[t]();
      this.roots.set(t, next);
      this.stage.append(next.el);
    }
    if (prev && prev !== next) {
      prev.onHide?.();
      hide(prev.el);
    }
    this.tab = t;
    this.rail.setActive(t);
    show(next.el, "fade");
    next.onShow?.();
  }

  /** Recreates a root tab (e.g. after sign-in or a new API key). */
  resetTab(t: TabId) {
    const s = this.roots.get(t);
    if (!s) return;
    s.onDestroy?.();
    s.el.remove();
    this.roots.delete(t);
    if (this.tab === t && !this.stack.length) this.showTab(t);
  }

  resetAll() {
    for (const t of [...this.roots.keys()]) if (t !== this.tab) this.resetTab(t);
    this.resetTab(this.tab);
  }

  push(s: Screen) {
    this.focusRail(false);
    const under = this.top;
    under?.onHide?.();
    this.stack.push(s);
    this.stage.append(s.el);
    document.body.classList.toggle("immersive", !!s.immersive);
    show(s.el, "push");
    if (under) hide(under.el, "behind");
    s.onShow?.();
  }

  pop(instant = false) {
    const s = this.stack.pop();
    if (!s) return;
    s.onHide?.();
    s.onDestroy?.();
    if (instant || settings().reducedMotion) s.el.remove();
    else {
      s.el.classList.add("leaving");
      s.el.addEventListener("animationend", () => s.el.remove(), { once: true });
      setTimeout(() => s.el.remove(), 600);
    }
    const now = this.top!;
    document.body.classList.toggle("immersive", !!(this.stack.length && now.immersive));
    show(now.el, instant ? undefined : "return");
    now.onShow?.();
  }

  openOverlay(o: Overlay) {
    this.overlays.push(o);
    this.overlayHost.append(o.el);
    o.el.classList.add("overlay-in");
  }

  closeOverlay() {
    const o = this.overlays.pop();
    if (!o) return;
    o.onClose?.();
    o.el.classList.add("overlay-out");
    setTimeout(() => o.el.remove(), settings().reducedMotion ? 0 : 220);
  }
}

function show(el: HTMLElement, anim?: "push" | "fade" | "return") {
  el.hidden = false;
  el.classList.remove("behind", "leaving", "anim-push", "anim-fade", "anim-return");
  if (anim && !settings().reducedMotion) {
    void el.offsetWidth; // restart the CSS animation
    el.classList.add(`anim-${anim}`);
  }
}

function hide(el: HTMLElement, mode?: "behind") {
  el.classList.remove("anim-push", "anim-fade", "anim-return");
  if (mode === "behind") {
    // Keep the screen underneath painted for an instant back transition, but
    // stop it from compositing once the new screen is opaque.
    el.classList.add("behind");
    setTimeout(() => {
      if (el.classList.contains("behind")) el.hidden = true;
    }, 400);
  } else el.hidden = true;
}

export function edgeBump() {
  rumble(0.25, 25);
  const el = document.querySelector<HTMLElement>(".focused");
  el?.animate([{ translate: "0 0" }, { translate: "4px 0" }, { translate: "-3px 0" }, { translate: "0 0" }], {
    duration: 180,
    easing: "ease-out",
  });
}

export const router = new Router();

/** Simple full-screen message used for empty and error states. */
export function messagePanel(title: string, body: string, actions: { label: string; run: () => void }[] = []) {
  let idx = 0;
  const buttons = actions.map((a, i) =>
    h("button.btn", { onclick: () => a.run(), "data-i": i }, a.label),
  );
  const el = h("div.message", null, h("h2", null, title), h("p", null, body), h("div.btn-row", null, ...buttons));
  const sync = () => buttons.forEach((b, i) => b.classList.toggle("focused", i === idx));
  sync();
  return {
    el,
    onAction(e: ActionEvent) {
      if (!actions.length) return false;
      if (e.action === "right" && idx < actions.length - 1) idx++;
      else if (e.action === "left" && idx > 0) idx--;
      else if (e.action === "select") actions[idx].run();
      else return false;
      sync();
      return true;
    },
  };
}
