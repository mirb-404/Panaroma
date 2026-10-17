// Controls tour: the screen fades behind a heavy vignette, a spotlight opens on
// the part of the interface each step is about, and an arrow points at it.
// There is one tour per input device (controller, keyboard, mouse); the first
// launch picks the connected one, and Settings → Controls replays any of them.
import { h, icon } from "../dom";
import { lastInputDevice, padConnected, type ActionEvent, type Device } from "../input";
import { router } from "../router";
import { settings } from "../settings";

type Key = [cap: string, label?: string];

interface Step {
  title: string;
  body: Record<Device, string> | string;
  keys?: Record<Device, Key[]>;
  /** What the spotlight opens on; nothing (or nothing visible) centers the card. */
  target?: () => Element | null | undefined;
}

export const DEVICE_LABEL: Record<Device, string> = { pad: "Controller", keyboard: "Keyboard", mouse: "Mouse" };
const DEVICES: Device[] = ["pad", "keyboard", "mouse"];

/** The screen currently shown (root tab or pushed screen). */
const visibleScreen = () => [...document.querySelectorAll<HTMLElement>(".stage > .screen:not([hidden])")].pop();
const railItem = (i: number) => document.querySelectorAll(".rail-item")[i];

const STEPS: Step[] = [
  {
    title: "",
    body: "",
  },
  {
    title: "Move around",
    body: {
      pad: "Use the stick or D-pad to move. Hold a direction to fly through a row.",
      keyboard: "Use the arrow keys to move. Hold one to fly through a row.",
      mouse: "Point at a video to select it. The wheel moves between rows, and the ‹ › arrows at a row's ends page through it.",
    },
    keys: {
      pad: [["L"], ["✚", "Move"]],
      keyboard: [["↑"], ["↓"], ["←"], ["→", "Move"]],
      mouse: [["Hover", "Select"], ["Wheel", "Scroll"]],
    },
    target: () => visibleScreen()?.querySelector(".row.active"),
  },
  {
    title: "Video previews",
    body: {
      pad: "Rest on a video for a moment and a muted preview plays right here.",
      keyboard: "Rest on a video for a moment and a muted preview plays right here.",
      mouse: "Hover a video for a moment and a muted preview plays right here.",
    },
    target: () => (visibleScreen()?.classList.contains("with-hero") ? document.querySelector(".backdrop-video") : null),
  },
  {
    title: "Open and go back",
    body: {
      pad: "Open a video to watch it. Going back from the player keeps it playing in a miniplayer.",
      keyboard: "Open a video to watch it. Going back from the player keeps it playing in a miniplayer.",
      mouse: "Click a selected video to watch it. The back button in the top-left corner (or your mouse's back button) returns, keeping the video in a miniplayer.",
    },
    keys: {
      pad: [["Ⓐ", "Open"], ["Ⓑ", "Back"]],
      keyboard: [["Enter", "Open"], ["Esc", "Back"]],
      mouse: [["Click", "Open"], ["←", "Back"]],
    },
    target: () => visibleScreen()?.querySelector(".card.focused"),
  },
  {
    title: "The menu",
    body: {
      pad: "Home, Subscriptions, Search and Library live here. Ⓑ from a row opens this menu; LB and RB switch tabs from anywhere.",
      keyboard: "Home, Subscriptions, Search and Library live here. Esc from a row opens this menu; [ and ] switch tabs from anywhere.",
      mouse: "Home, Subscriptions, Search and Library live here. Click one to jump straight to it.",
    },
    keys: {
      pad: [["LB"], ["RB", "Tabs"], ["Ⓑ", "Menu"]],
      keyboard: [["["], ["]", "Tabs"], ["Esc", "Menu"]],
      mouse: [["Click", "Go"]],
    },
    target: () => document.querySelector(".rail-items"),
  },
  {
    title: "Settings",
    body: {
      pad: "☰ opens Panorama's settings from anywhere, and pressing it again goes back. These tutorials live there too.",
      keyboard: "S opens Panorama's settings from anywhere, and pressing it again goes back. These tutorials live there too.",
      mouse: "Click the gear for Panorama's settings. These tutorials live there too.",
    },
    keys: {
      pad: [["☰", "Settings"]],
      keyboard: [["S", "Settings"]],
      mouse: [["Click ⚙", "Settings"]],
    },
    target: () => railItem(4),
  },
  {
    title: "Search",
    body: {
      pad: "Ⓨ jumps to Search and opens the on-screen keyboard.",
      keyboard: "/ jumps to Search. Just start typing.",
      mouse: "Click Search, then type or click the on-screen keys.",
    },
    keys: {
      pad: [["Ⓨ", "Search"]],
      keyboard: [["/", "Search"]],
      mouse: [["Click 🔍", "Search"]],
    },
    target: () => railItem(2),
  },
  {
    title: "While watching",
    body: {
      pad: "Captions, speed, quality and the ultrawide layout are in playback settings.",
      keyboard: "Captions, speed, quality and the ultrawide layout are in playback settings. YouTube's K, J, L, M and C keys work too.",
      mouse: "Captions, speed, quality and the ultrawide layout are in playback settings. YouTube's own controls handle seeking and volume.",
    },
    keys: {
      pad: [["◀ ▶", "Seek"], ["▲ ▼", "Volume"], ["Ⓐ", "Pause"], ["☰", "Playback settings"]],
      keyboard: [["← →", "Seek"], ["↑ ↓", "Volume"], ["Space", "Pause"], ["S", "Playback settings"]],
      mouse: [["Click", "Pause"], ["Right-click", "Playback settings"]],
    },
  },
  {
    title: "You're all set",
    body: "Replay this tour any time from Settings → Controls.",
  },
];

/** Picks the tour for the device in use: a connected controller wins. */
export async function detectDevice(): Promise<Device> {
  if (lastInputDevice() === "pad" || (await padConnected())) return "pad";
  return lastInputDevice();
}

let open = false;

/** Shows the controls tour. `welcome` turns the first card into the first-launch greeting. */
export function showTutorial(device: Device, opts: { welcome?: boolean } = {}): Promise<void> {
  if (open) return Promise.resolve();
  open = true;
  let i = 0;

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = (tag: string, attrs: Record<string, string>) => {
    const el = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  // One SVG draws the dim, the vignette and the spotlight hole, so the hole stays
  // perfectly clear even right at the screen's edge (the rail).
  const hole = svg("rect", { class: "tut-hole", fill: "#000", rx: "18" });
  const mask = svg("mask", { id: "tut-mask" });
  mask.append(svg("rect", { width: "100%", height: "100%", fill: "#fff" }), hole);
  const grad = svg("radialGradient", { id: "tut-vignette", cx: "50%", cy: "50%", r: "75%" });
  grad.append(
    svg("stop", { offset: "35%", "stop-color": "#000", "stop-opacity": "0.72" }),
    svg("stop", { offset: "100%", "stop-color": "#000", "stop-opacity": "0.97" }),
  );
  const defs = svg("defs", {});
  defs.append(mask, grad);
  const shade = svg("svg", { class: "tut-shade" });
  shade.append(defs, svg("rect", { width: "100%", height: "100%", fill: "url(#tut-vignette)", mask: "url(#tut-mask)" }));

  const ring = h("div.tut-ring");
  const arrow = h("div.tut-arrow", null, h("span"));
  const chips = h("div.tut-devices");
  const dots = h("div.tut-dots");
  const title = h("h2.tut-title");
  const body = h("p.tut-body");
  const keys = h("div.tut-keys");
  const prevBtn = h("button.btn.tut-prev", { onclick: () => go(-1) }, "Back");
  const nextBtn = h("button.btn.focused.tut-next", { onclick: () => go(1) });
  const skipBtn = h("button.tut-skip", { onclick: () => finish() }, "Skip tour");
  const hint = h("p.tut-hint");
  const card = h(
    "div.tut-card",
    null,
    chips,
    dots,
    title,
    body,
    keys,
    h("div.tut-nav", null, prevBtn, nextBtn, skipBtn),
    hint,
  );
  const el = h("div.overlay.tutorial", null, shade, ring, arrow, card);

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  function render() {
    const step = STEPS[i];
    const last = i === STEPS.length - 1;
    chips.replaceChildren(
      ...DEVICES.map((d) =>
        h(
          `button.tut-chip${d === device ? ".on" : ""}`,
          { onclick: () => ((device = d), render()) },
          icon(d === "pad" ? "pad" : d === "keyboard" ? "keyboard" : "mouse"),
          h("span", null, DEVICE_LABEL[d]),
        ),
      ),
    );
    dots.replaceChildren(...STEPS.map((_, n) => h(`span${n === i ? ".on" : n < i ? ".past" : ""}`)));
    if (i === 0) {
      title.textContent = opts.welcome ? "Welcome to Panorama" : `${DEVICE_LABEL[device]} controls`;
      body.textContent = opts.welcome
        ? `Here's a quick tour of the ${DEVICE_LABEL[device].toLowerCase()} controls. It takes about thirty seconds.`
        : "A quick tour of how to get around.";
    } else {
      title.textContent = step.title;
      body.textContent = typeof step.body === "string" ? step.body : step.body[device];
    }
    title.classList.toggle("tut-welcome", i === 0 && !!opts.welcome);
    keys.replaceChildren(
      ...(step.keys?.[device] ?? []).map(([cap, label]) =>
        h("span.tut-key", null, h("kbd", null, cap), label ? h("span", null, label) : null),
      ),
    );
    prevBtn.hidden = i === 0;
    nextBtn.textContent = last ? (opts.welcome ? "Start watching" : "Done") : i === 0 ? "Show me" : "Next";
    skipBtn.hidden = last;
    hint.textContent =
      device === "pad"
        ? "Ⓐ next   ◀ back   Ⓑ skip   Ⓧ switch device"
        : device === "keyboard"
          ? "Enter next   ← back   Esc skip   X switch device"
          : "Click Next, or pick another device above";
    for (const n of [title, body, keys]) {
      n.getAnimations().forEach((a) => a.cancel());
      if (!settings().reducedMotion)
        n.animate([{ opacity: 0, translate: "0 0.5rem" }, { opacity: 1, translate: "0 0" }], {
          duration: 320,
          easing: "cubic-bezier(.2,.8,.2,1)",
        });
    }
    place();
  }

  /** Opens the spotlight on the step's target and parks the card and arrow beside it. */
  function place() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const target = STEPS[i].target?.();
    const r = target?.getBoundingClientRect();
    const visible = r && r.width > 4 && r.height > 4 && r.right > 0 && r.bottom > 0 && r.left < W && r.top < H;
    const pad = 14;
    const spot = visible
      ? {
          x: Math.max(6, r.left - pad),
          y: Math.max(6, r.top - pad),
          w: Math.min(W - 12, r.width + pad * 2),
          h: Math.min(H - 12, r.height + pad * 2),
        }
      : { x: W / 2, y: H / 2, w: 0, h: 0 };
    hole.style.x = `${spot.x}px`;
    hole.style.y = `${spot.y}px`;
    hole.style.width = `${spot.w}px`;
    hole.style.height = `${spot.h}px`;
    Object.assign(ring.style, {
      left: `${spot.x}px`,
      top: `${spot.y}px`,
      width: `${spot.w}px`,
      height: `${spot.h}px`,
    });
    ring.classList.toggle("on", !!visible);
    arrow.classList.toggle("on", !!visible);

    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    if (!visible) {
      card.style.left = `${(W - cw) / 2}px`;
      card.style.top = `${(H - ch) / 2}px`;
      return;
    }
    // The free band (left / right / above / below the spotlight) that fits the card best.
    const gap = 90;
    const bands = [
      { side: "left", x: 0, y: 0, w: spot.x - gap, h: H },
      { side: "right", x: spot.x + spot.w + gap, y: 0, w: W - spot.x - spot.w - gap, h: H },
      { side: "top", x: 0, y: 0, w: W, h: spot.y - gap },
      { side: "bottom", x: 0, y: spot.y + spot.h + gap, w: W, h: H - spot.y - spot.h - gap },
    ];
    const fit = (b: (typeof bands)[number]) => Math.min(b.w / cw, b.h / ch);
    const best = bands.reduce((a, b) => (fit(b) > fit(a) ? b : a));
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const cx = best.side === "left" || best.side === "right" ? best.x + (best.w - cw) / 2 : spot.x + spot.w / 2 - cw / 2;
    const cy = best.side === "top" || best.side === "bottom" ? best.y + (best.h - ch) / 2 : spot.y + spot.h / 2 - ch / 2;
    const left = clamp(cx, 24, W - cw - 24);
    const top = clamp(cy, 24, H - ch - 24);
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;

    // The arrow sits in the gap between card and spotlight, pointing at the spotlight.
    const midY = clamp(top + ch / 2, spot.y + 20, spot.y + spot.h - 20);
    const midX = clamp(left + cw / 2, spot.x + 20, spot.x + spot.w - 20);
    const at =
      best.side === "right"
        ? { x: spot.x + spot.w + gap / 2, y: midY, rot: 0 }
        : best.side === "left"
          ? { x: spot.x - gap / 2, y: midY, rot: 180 }
          : best.side === "bottom"
            ? { x: midX, y: spot.y + spot.h + gap / 2, rot: 90 }
            : { x: midX, y: spot.y - gap / 2, rot: -90 };
    arrow.style.left = `${at.x}px`;
    arrow.style.top = `${at.y}px`;
    arrow.style.rotate = `${at.rot}deg`;
  }

  function go(d: 1 | -1) {
    if (d === 1 && i === STEPS.length - 1) return finish();
    i = Math.max(0, Math.min(STEPS.length - 1, i + d));
    render();
  }

  let closed = false;
  function finish() {
    if (closed) return;
    router.closeOverlay();
  }

  const onResize = () => place();
  window.addEventListener("resize", onResize);

  router.openOverlay({
    el,
    onAction(e: ActionEvent) {
      if (e.repeat) return true;
      switch (e.action) {
        case "select":
        case "right":
        case "nextTab":
          go(1);
          return true;
        case "left":
        case "prevTab":
          if (i === 0) return true;
          go(-1);
          return true;
        case "alt":
          device = DEVICES[(DEVICES.indexOf(device) + 1) % DEVICES.length];
          render();
          return true;
        case "back":
          return false; // the router closes the overlay
        default:
          return true; // nothing leaks to the screen underneath
      }
    },
    onClose() {
      closed = true;
      open = false;
      window.removeEventListener("resize", onResize);
      resolveDone();
    },
  });
  // Card size is known once it's in the document.
  requestAnimationFrame(render);
  return done;
}
