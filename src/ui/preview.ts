// Video previews, Netflix-style. Rest on a video (controller focus or mouse
// hover) and it starts playing muted: in the big hero area on screens that have
// one, otherwise inside the card's thumbnail. After a while it fades back to the
// image. Opening the video continues from where the preview got to.
import { h } from "../dom";
import { isTauri } from "../platform";
import { settings } from "../settings";

/** Long enough that sweeping across cards doesn't start a preview for each one. */
const DWELL_MS = 250;
/** How long a hero preview plays before returning to the image. */
const HERO_PLAY_MS = 30_000;
const CARD_PLAY_MS = 8000;
/**
 * YouTube's player flashes a play icon and title bar right after playback
 * starts. In the desktop app the embed script hides them ("preview-ready"), so
 * the preview fades in almost at once; elsewhere it waits a moment longer.
 * (The title bar is also cropped in CSS: the frame is taller than its box.)
 */
const REVEAL_DELAY_MS = 120;
const REVEAL_DELAY_UNHOOKED_MS = 1000;
let chromeHidden = false;
const YT = "https://www.youtube.com";

let timer = 0;
let stopTimer = 0;
let revealTimer = 0;
let handshake = 0;
let giveUp = 0;
/** No playback by then (embed blocked, ad wall, slow network): drop it. */
const START_TIMEOUT_MS = 12_000;
let active: { host: HTMLElement; frame: HTMLIFrameElement; id: string; hero: boolean } | null = null;
/** Where the last preview got to, so the player can pick up from there. */
let progress: { id: string; t: number } | null = null;

/** The hero-area container, provided by the backdrop. */
let heroHost: HTMLElement | null = null;
export function setHeroPreviewHost(el: HTMLElement) {
  heroHost = el;
}

/**
 * Starts a preview after the dwell time unless focus moves first. With no
 * `cardHost`, the preview plays in the hero area.
 */
export function schedulePreview(videoId: string, cardHost?: HTMLElement) {
  const host = cardHost ?? heroHost;
  if (!host || (active?.host === host && active.id === videoId)) return;
  cancelPreview();
  if (!settings().hoverPreview || settings().reducedMotion) return;
  timer = window.setTimeout(() => start(host, videoId, !cardHost), DWELL_MS);
}

export function cancelPreview() {
  clearTimeout(timer);
  clearTimeout(stopTimer);
  clearTimeout(revealTimer);
  revealTimer = 0;
  clearInterval(handshake);
  clearTimeout(giveUp);
  const a = active;
  active = null;
  if (!a) return;
  a.host.classList.remove("previewing");
  a.frame.classList.remove("shown");
  // Let the fade finish before tearing the player down.
  setTimeout(() => a.frame.remove(), 450);
}

/**
 * Detaches the visible preview of `videoId` for the player to adopt (still
 * playing, still in the DOM). Null if that video isn't previewing.
 */
export function takePreview(videoId: string): HTMLIFrameElement | null {
  const a = active;
  if (!a || a.id !== videoId || !a.frame.classList.contains("shown")) return null;
  clearTimeout(timer);
  clearTimeout(stopTimer);
  clearTimeout(revealTimer);
  revealTimer = 0;
  clearInterval(handshake);
  clearTimeout(giveUp);
  active = null;
  a.host.classList.remove("previewing");
  return a.frame;
}

/** Seconds into `videoId` that its preview reached (0 if it wasn't previewed). */
export function previewTime(videoId: string): number {
  return progress?.id === videoId ? progress.t : 0;
}

function start(host: HTMLElement, id: string, hero: boolean) {
  const params = new URLSearchParams({
    autoplay: "1",
    mute: "1",
    // Same player settings as the full player, so a preview can be handed
    // over to it. Controls only appear on hover, and previews ignore the pointer.
    controls: "1",
    fs: "0",
    iv_load_policy: "3",
    playsinline: "1",
    rel: "0",
    enablejsapi: "1",
    origin: location.origin,
    hl: navigator.language,
  });
  const frame = h("iframe.preview-frame", {
    // The marker lets the embed script hide YouTube's overlays from the first frame.
    src: `${YT}/embed/${id}?${params}#panorama-preview`,
    allow: "autoplay; encrypted-media",
    referrerpolicy: "strict-origin-when-cross-origin",
    tabindex: "-1",
    title: "",
  });
  // Subscribe to the player's state and time. Like YouTube's own API library,
  // keep announcing until the player answers: a single message sent at "load"
  // can arrive before the player is listening, and then the preview would
  // never learn it's playing (and never show).
  const announce = () => {
    frame.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), YT);
    if (!chromeHidden) frame.contentWindow?.postMessage({ panorama: "preview" }, YT);
  };
  frame.addEventListener("load", announce);
  host.append(frame);
  active = { host, frame, id, hero };
  answered = false;
  // Only the desktop app has the embed script that answers "preview".
  chromeHidden = !isTauri;
  clearInterval(handshake);
  // Faster than the player's own handshake: every 100 ms counts here.
  handshake = window.setInterval(() => (answered && chromeHidden ? clearInterval(handshake) : announce()), 100);
  giveUp = window.setTimeout(() => active?.frame === frame && !frame.classList.contains("shown") && cancelPreview(), START_TIMEOUT_MS);
  progress = { id, t: 0 };
}

let answered = false;

window.addEventListener("message", (e) => {
  if (e.origin !== YT || !active || e.source !== active.frame.contentWindow) return;
  answered = true;
  let data: any;
  try {
    data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
  } catch {
    return;
  }
  if (data?.panorama === "preview-ready") {
    chromeHidden = true;
    return;
  }
  const info = data?.info;
  if (typeof info?.currentTime === "number" && progress?.id === active.id) progress.t = info.currentTime;
  const state = info?.playerState;
  // Fade in only once the video is really playing (never a black box or
  // spinner); in the hero, also wait out YouTube's start-of-playback overlay.
  if (state === 1 && !active.frame.classList.contains("shown") && !revealTimer) {
    const a = active;
    revealTimer = window.setTimeout(
      () => {
        revealTimer = 0;
        if (active !== a) return;
        a.frame.classList.add("shown");
        a.host.classList.add("previewing");
        stopTimer = window.setTimeout(cancelPreview, a.hero ? HERO_PLAY_MS : CARD_PLAY_MS);
      },
      chromeHidden && isTauri ? REVEAL_DELAY_MS : REVEAL_DELAY_UNHOOKED_MS,
    );
  } else if (state === 0) cancelPreview();
  else if (data?.event === "onError") cancelPreview();
});

/** Keep the preview from stealing keyboard focus from the app. */
window.addEventListener("blur", () => {
  if (active && document.activeElement === active.frame) active.frame.blur();
});
