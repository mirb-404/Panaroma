// Unifies keyboard, mouse wheel and controller into one action stream with
// TV-style auto-repeat: a deliberate first delay, then accelerating repeats so
// long rows can be skimmed quickly while single taps stay precise.
import { invoke, listen } from "./platform";

export type Action =
  | "up" | "down" | "left" | "right"
  | "select" | "back" | "menu"
  | "search" | "info" | "alt"
  | "prevTab" | "nextTab"
  | "rewind" | "forward"
  | "fullscreen";

export interface ActionEvent {
  action: Action;
  repeat: boolean;
  /** How many repeats so far: lets the player scale seek distance while held. */
  count: number;
  source: "keyboard" | "pad" | "wheel" | "mouse";
}

type Handler = (e: ActionEvent) => void;
let handler: Handler = () => {};
export function setActionHandler(h: Handler) {
  handler = h;
}

/** A one-shot action from an on-screen control (e.g. the mouse back button). */
export function trigger(action: Action, source: ActionEvent["source"] = "mouse") {
  lastDevice = source === "pad" ? "pad" : source === "keyboard" ? "keyboard" : "mouse";
  handler({ action, repeat: false, count: 0, source });
}

/** The device the user touched most recently: picks which controls to teach. */
export type Device = "keyboard" | "mouse" | "pad";
let lastDevice: Device = "keyboard";
export const lastInputDevice = () => lastDevice;

const REPEATABLE = new Set<Action>(["up", "down", "left", "right", "rewind", "forward"]);
const FIRST_DELAY = 360;
const START_RATE = 140;
const MIN_RATE = 42;

const held = new Map<string, { action: Action; timer: number; count: number; source: ActionEvent["source"] }>();

function press(id: string, action: Action, source: ActionEvent["source"]) {
  if (held.has(id)) return;
  lastDevice = source === "pad" ? "pad" : source === "keyboard" ? "keyboard" : "mouse";
  handler({ action, repeat: false, count: 0, source });
  if (!REPEATABLE.has(action)) {
    held.set(id, { action, timer: 0, count: 0, source });
    return;
  }
  const state = { action, timer: 0, count: 0, source };
  const tick = (delay: number) => {
    state.timer = window.setTimeout(() => {
      state.count++;
      handler({ action, repeat: true, count: state.count, source });
      tick(Math.max(MIN_RATE, START_RATE * Math.pow(0.86, state.count)));
    }, delay);
  };
  tick(FIRST_DELAY);
  held.set(id, state);
}

function release(id: string) {
  const s = held.get(id);
  if (s) clearTimeout(s.timer);
  held.delete(id);
}

export function releaseAll() {
  for (const id of [...held.keys()]) release(id);
}

// ---- keyboard ----------------------------------------------------------------

const KEYS: Record<string, Action> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Enter: "select",
  " ": "select",
  Escape: "back",
  Backspace: "back",
  BrowserBack: "back",
  GoBack: "back",
  F11: "fullscreen",
  "/": "search",
  "[": "prevTab",
  "]": "nextTab",
  ",": "rewind",
  ".": "forward",
  i: "info",
  I: "info",
  s: "menu",
  S: "menu",
  x: "alt",
  X: "alt",
  ContextMenu: "menu",
  MediaPlayPause: "select",
};

/** When a text field has focus, typing must reach it rather than become actions. */
let textCapture: ((e: KeyboardEvent) => boolean) | null = null;
export function captureText(fn: ((e: KeyboardEvent) => boolean) | null) {
  textCapture = fn;
}

window.addEventListener(
  "keydown",
  (e) => {
    if (textCapture && textCapture(e)) {
      e.preventDefault();
      return;
    }
    const a = KEYS[e.key];
    if (!a) return;
    e.preventDefault();
    press(`k:${e.code || e.key}`, a, "keyboard");
  },
  { capture: true },
);
window.addEventListener("keyup", (e) => release(`k:${e.code || e.key}`), { capture: true });
window.addEventListener("blur", releaseAll);

// ---- pointer ---------------------------------------------------------------------

let pointerMovedAt = 0;
window.addEventListener("mousemove", (e) => {
  if (e.movementX || e.movementY) {
    pointerMovedAt = performance.now();
    lastDevice = "mouse";
  }
});
window.addEventListener("mousedown", () => (lastDevice = "mouse"), { capture: true });
// Mouse "back" side button: the same as Esc / Ⓑ, never browser history.
window.addEventListener(
  "mouseup",
  (e) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    if (e.button === 3) trigger("back");
  },
  { capture: true },
);
/**
 * True only right after the user physically moved the mouse. Hover handlers use
 * it so content scrolling underneath a resting cursor can't steal focus.
 */
export const pointerIsActive = () => performance.now() - pointerMovedAt < 250;

// ---- mouse wheel ---------------------------------------------------------------

let wheelAcc = 0;
window.addEventListener(
  "wheel",
  (e) => {
    lastDevice = "mouse";
    if ((e.target as HTMLElement).closest?.("[data-native-scroll]")) return;
    wheelAcc += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
    while (Math.abs(wheelAcc) >= 60) {
      const fwd = wheelAcc > 0;
      wheelAcc -= fwd ? 60 : -60;
      handler({
        action: horizontal ? (fwd ? "right" : "left") : fwd ? "down" : "up",
        repeat: false,
        count: 0,
        source: "wheel",
      });
    }
  },
  { passive: true },
);

// ---- controllers ---------------------------------------------------------------
// Two sources, one action stream:
//  1. The web Gamepad API (primary). Chromium/WebView2 maps Xbox, DualShock 4,
//     DualSense, Switch Pro and most HID pads to the W3C "standard" layout.
//  2. Native input from Rust (gilrs), used only while the web API sees no pad,
//     so a press is never delivered twice.

const PAD: Record<string, Action> = {
  Up: "up",
  Down: "down",
  Left: "left",
  Right: "right",
  A: "select",
  B: "back",
  X: "alt",
  Y: "search",
  Menu: "menu",
  View: "info",
  LB: "prevTab",
  RB: "nextTab",
  LT: "rewind",
  RT: "forward",
  RS: "fullscreen",
};

/** W3C standard-mapping button indices (Xbox labels; PlayStation ✕ ○ □ △ map to A B X Y). */
const STANDARD: Record<number, string> = {
  0: "A",
  1: "B",
  2: "X",
  3: "Y",
  4: "LB",
  5: "RB",
  6: "LT",
  7: "RT",
  8: "View",
  9: "Menu",
  11: "RS",
  12: "Up",
  13: "Down",
  14: "Left",
  15: "Right",
};

type PadEvent =
  | { type: "down" | "up"; button: string }
  | { type: "axis"; axis: string; value: number }
  | { type: "connected"; name: string }
  | { type: "disconnected" };

let padListener: (e: PadEvent) => void = () => {};
export function onPadStatus(fn: (e: PadEvent) => void) {
  padListener = fn;
}

const webPads = () => (navigator.getGamepads?.() ?? []).filter((p): p is Gamepad => !!p && p.connected);

/**
 * True when a controller is plugged in. The web API only reveals a pad after
 * one of its buttons is pressed, so the native side is asked as well.
 */
export async function padConnected(): Promise<boolean> {
  if (webPads().length) return true;
  return invoke<boolean>("pad_connected").catch(() => false);
}

export async function initPad() {
  // Native events: only when the web API can't see a controller.
  await listen<PadEvent>("pad", (e) => {
    if (e.type === "down") {
      if (webPads().length) return;
      const a = PAD[e.button];
      if (a) press(`p:${e.button}`, a, "pad");
    } else if (e.type === "up") {
      release(`p:${e.button}`);
    } else if (!webPads().length) {
      padListener(e);
    }
  });

  window.addEventListener("gamepadconnected", (e) => {
    padListener({ type: "connected", name: friendlyName(e.gamepad.id) });
    // Hand over from native input: release anything it still holds.
    for (const id of [...held.keys()]) if (id.startsWith("p:")) release(id);
  });
  window.addEventListener("gamepaddisconnected", () => padListener({ type: "disconnected" }));
  requestAnimationFrame(pollWebPads);
}

/** "Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)" → "Wireless Controller" */
function friendlyName(id: string): string {
  return id.replace(/\s*\(.*$/, "").trim() || "Controller";
}

// Stick hysteresis, as on the native side: press past 0.55, release under 0.35.
const PRESS = 0.55;
const RELEASE = 0.35;
/** Per-pad state (for stick hysteresis). */
const padState = new Map<number, Set<string>>();
/**
 * Buttons held on ANY pad. Actions fire from changes to this union, so a
 * controller that Windows exposes twice (e.g. a PlayStation pad plus its
 * DS4Windows / ViGEm virtual Xbox twin) acts as one: no double presses.
 */
let combined: Set<string> | null = null;

function pollWebPads() {
  // Only the focused app window takes controller input.
  if (document.hasFocus()) {
    const union = new Set<string>();
    for (const gp of webPads()) {
      const prev = padState.get(gp.index);
      const now = new Set<string>();
      const standard = gp.mapping === "standard";
      gp.buttons.forEach((b, i) => {
        const name = standard ? STANDARD[i] : i < 4 ? STANDARD[i] : undefined;
        const threshold = name === "LT" || name === "RT" ? 0.4 : 0.5;
        if (name && (b.pressed || b.value > threshold)) now.add(name);
      });
      const [lx = 0, ly = 0] = gp.axes;
      const stick = (neg: string, pos: string, v: number) => {
        const was = prev?.has(neg) ? -1 : prev?.has(pos) ? 1 : 0;
        if (was === 1 ? v > RELEASE : v >= PRESS) now.add(pos);
        else if (was === -1 ? v < -RELEASE : v <= -PRESS) now.add(neg);
      };
      stick("Left", "Right", lx);
      stick("Up", "Down", ly);
      padState.set(gp.index, now);
      now.forEach((n) => union.add(n));
    }
    // First poll: adopt the current state silently so a button already held
    // (e.g. the press that woke the Gamepad API) isn't repeated.
    if (combined) {
      for (const n of union) if (!combined.has(n) && PAD[n]) press(`w:${n}`, PAD[n], "pad");
      for (const n of combined) if (!union.has(n)) release(`w:${n}`);
    }
    combined = union;
  } else if (combined) {
    // Focus lost mid-hold: release everything so nothing keeps repeating.
    for (const id of [...held.keys()]) if (id.startsWith("w:")) release(id);
    padState.clear();
    combined = null;
  }
  requestAnimationFrame(pollWebPads);
}

/** Light haptic tick through the web Gamepad API when the pad exposes one. */
export function rumble(strength = 0.35, ms = 30) {
  try {
    for (const gp of navigator.getGamepads?.() ?? []) {
      (gp as any)?.vibrationActuator?.playEffect?.("dual-rumble", {
        duration: ms,
        strongMagnitude: strength * 0.6,
        weakMagnitude: strength,
      });
    }
  } catch {
    /* haptics are best-effort */
  }
}
