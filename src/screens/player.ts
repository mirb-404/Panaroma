// Playback through the official YouTube IFrame Player. Panorama never draws over
// the player's own surface during playback (YouTube API policy); on ultrawide
// screens the 16:9 video leaves pillarbox space, which hosts the info / up-next
// panel instead. Controller input drives the player through its public JS API.
import * as api from "../api";
import { decodeEntities, fmtDuration, h, icon } from "../dom";
import { pointerIsActive, type ActionEvent } from "../input";
import { flip } from "../motion";
import { isFullscreen, isTauri, listen, openYouTube, setFullscreen } from "../platform";
import { router, type Screen } from "../router";
import { openChannel } from "../routes";
import { settings, updateSettings, type Settings } from "../settings";
import { cue } from "../sound";
import { setBackdrop, toast } from "../ui/chrome";
import { openComments, openSaveTo } from "../ui/watchpanels";

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiReady: Promise<any> | null = null;
/** Loads YouTube's IFrame API once (also called at startup to warm it up). */
export function loadIframeApi(): Promise<any> {
  apiReady ??= new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => {
      apiReady = null;
      reject(new Error("Couldn't reach YouTube"));
    };
    document.head.append(s);
  });
  return apiReady;
}

/**
 * Controls a player iframe that is already connected — an adopted preview.
 * YouTube's player only performs its API handshake once, so `new YT.Player()`
 * can't attach to it again; this speaks the same postMessage protocol over the
 * connection the preview opened, exposing the subset of the YT.Player
 * interface this screen uses.
 */
class AdoptedPlayer {
  private info: Record<string, any> = {};
  private onMessage = (e: MessageEvent) => {
    if (e.origin !== YT_ORIGIN || e.source !== this.frame.contentWindow) return;
    let d: any;
    try {
      d = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
    } catch {
      return;
    }
    if ((d?.event === "infoDelivery" || d?.event === "initialDelivery") && d.info) {
      const before = this.info.playerState;
      Object.assign(this.info, d.info);
      if (d.info.playerState !== undefined && d.info.playerState !== before) this.events.onStateChange({ data: d.info.playerState });
    } else if (d?.event === "onError") this.events.onError({ data: d.info });
  };

  constructor(
    private frame: HTMLIFrameElement,
    private events: { onStateChange: (e: any) => void; onError: (e: any) => void },
    currentTime = 0,
  ) {
    // Adopted previews are playing; changes arrive as deltas from here on.
    this.info.playerState = 1;
    this.info.currentTime = currentTime;
    window.addEventListener("message", this.onMessage);
  }

  private cmd(func: string, args: unknown[] = []) {
    this.frame.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args, id: 1, channel: "widget" }), YT_ORIGIN);
  }

  playVideo() { this.cmd("playVideo"); }
  pauseVideo() { this.cmd("pauseVideo"); }
  seekTo(t: number, allowSeekAhead: boolean) { this.info.currentTime = t; this.cmd("seekTo", [t, allowSeekAhead]); }
  getCurrentTime(): number { return this.info.currentTime ?? 0; }
  getDuration(): number { return this.info.duration ?? 0; }
  getVolume(): number { return this.info.volume ?? 100; }
  setVolume(v: number) { this.info.volume = v; this.cmd("setVolume", [v]); }
  isMuted(): boolean { return !!this.info.muted; }
  mute() { this.info.muted = true; this.cmd("mute"); }
  unMute() { this.info.muted = false; this.cmd("unMute"); }
  loadVideoById(id: string) { this.info.currentTime = 0; this.cmd("loadVideoById", [id, 0]); }
  getPlaybackRate(): number { return this.info.playbackRate ?? 1; }
  setPlaybackRate(r: number) { this.info.playbackRate = r; this.cmd("setPlaybackRate", [r]); }
  getPlaybackQuality(): string { return this.info.playbackQuality ?? ""; }
  loadModule(m: string) { this.cmd("loadModule", [m]); }
  setOption(m: string, k: string, v: unknown) { this.cmd("setOption", [m, k, v]); }
  unloadModule(m: string) { this.cmd("unloadModule", [m]); }
  setSize(w: number, h: number) { this.frame.width = String(w); this.frame.height = String(h); }
  getIframe(): HTMLIFrameElement { return this.frame; }
  destroy() { window.removeEventListener("message", this.onMessage); this.frame.remove(); }
}

const YT_ORIGIN = "https://www.youtube.com";

const enum State {
  Ended = 0,
  Playing = 1,
  Paused = 2,
  Buffering = 3,
}

type Layout = "split" | "theater";

/**
 * `handoff`: a preview player that is already playing this video. It is moved
 * into the player (without reloading) and unmuted, so playback just continues.
 */
export function playerScreen(first: api.Video, queue: api.Video[], startAt = 0, handoff?: HTMLIFrameElement): Screen {
  let pos = Math.max(0, queue.findIndex((v) => v.id === first.id));
  if (!queue.length) queue = [first];
  let current = queue[pos];
  let player: any = null;
  let state = -1;
  let focus: "video" | "queue" = "video";
  let qIdx = pos;
  let pendingSeek: number | null = null;
  let seekCommit = 0;
  let autoNext = 0;
  let progressTimer = 0;
  let destroyed = false;
  let errored = false;
  let resumeOnShow = false;

  const aspect = () => window.innerWidth / window.innerHeight;
  // 21:9 with "Fill ultrawide screens" on opens zoomed full-width. 32:9 and
  // wider always open with the side panel: zooming 16:9 to fill them would crop
  // half the picture, so the panel uses the space instead. Ⓨ switches.
  let layout: Layout = aspect() >= 3.2 || (aspect() >= 2.0 && !settings().ultrawideFill) ? "split" : "theater";

  // Ultrawide fill: in theater layout the 16:9 player is zoomed (≤1.4×) to fill
  // the width, cropping top and bottom. In the desktop app the player is
  // "hooked" (see src-tauri/src/ytembed.js) and keeps its captions and controls
  // inside the visible area. Without the hook it zooms out while paused, right
  // after a click into the player, and whenever captions are on.
  const MAX_ZOOM = 1.4;
  let unzoomed = true; // until playback starts
  let rezoomTimer = 0;
  let hooked = false;
  let captionsOn = false;
  /** Hooked only: the qualities YouTube offers (best first), what plays, and the viewer's pick. */
  let qualities: { quality: string; label: string }[] = [];
  let qualityNow = "";
  let qualityPick = "auto";
  /** Docked bottom right as a miniplayer (Back from the player). */
  let mini = false;
  function fillZoom(W: number, H: number): number {
    if (mini || layout !== "theater" || !settings().ultrawideFill || unzoomed) return 1;
    if (captionsOn && !hooked) return 1;
    return Math.min(MAX_ZOOM, Math.max(1, W / ((H * 16) / 9)));
  }
  function setUnzoomed(on: boolean) {
    clearTimeout(rezoomTimer);
    if (unzoomed === on) return;
    const from = videoBox.getBoundingClientRect();
    unzoomed = on;
    sizeVideo();
    if (from.width) flip(videoBox, from, 520);
  }

  // ---- DOM --------------------------------------------------------------------
  const host = h("div");
  // Miniplayer: click to expand, ✕ (or Back) to close.
  const miniClose = h(
    "button.mini-close",
    {
      title: "Close",
      onclick: (ev: Event) => {
        ev.stopPropagation();
        router.closeMini();
      },
    },
    "✕",
  );
  const miniHint = h("div.mini-hint", null, "Ⓑ / Esc close  ·  View / I expand");
  const videoBox = h("div.video-box", { onclick: () => mini && router.restoreMini() }, host, miniClose, miniHint);
  const ambient = h("div.player-ambient");
  const osd = h("div.osd");
  const titleEl = h("h1.np-title");
  const lineEl = h("div.np-line");
  const channelBtn = h("button.np-channel", { onclick: () => openChannel(current.channelId) });
  const descEl = h("p.np-desc", { "data-native-scroll": true });
  const timeEl = h("div.np-time");
  const barFill = h("div.np-bar-fill");
  const bar = h("div.np-bar", null, barFill);
  const stateEl = h("div.np-state");
  const queueEl = h("div.queue", { "data-native-scroll": true });
  // The viewer's account actions for the current video (also in the ☰ menu).
  const actBtn = (name: Parameters<typeof icon>[0], run: () => void) =>
    h("button.np-act", { onclick: run }, icon(name, "icon np-act-icon"), h("span"));
  const likeBtn = actBtn("like", () => toggleLike());
  const saveBtn = actBtn("add", () => openSaveTo(current));
  const commentsBtn = actBtn("comments", () => showComments());
  const subBtn = actBtn("subscribe", () => toggleSubscribe());
  const actionsEl = h("div.np-actions", null, likeBtn, saveBtn, commentsBtn, subBtn);
  // Each hint is unbreakable, so narrow panels wrap between hints, not inside them.
  const hints = (items: string[]) => h("div.legend-line", null, ...items.map((t) => h("span", null, t)));
  const legend = h(
    "div.legend",
    null,
    hints(["Ⓐ play/pause", "◀ ▶ seek", "▲ ▼ volume", "LB/RB prev/next", "Ⓨ layout", "☰ menu · save · comments", "⧉ channel", "Ⓑ back"]),
    hints(["Keyboard:", "Space/K play", "J L seek", "M mute", "C captions", "S settings", "Esc back"]),
  );
  const panel = h(
    "aside.np-panel",
    null,
    h("div.np-now", null, stateEl, timeEl, bar),
    titleEl,
    channelBtn,
    lineEl,
    actionsEl,
    descEl,
    h("h3.queue-title", null, "Up next"),
    queueEl,
    legend,
  );
  const el = h("section.screen.player-screen", null, ambient, h("div.player-stage", null, videoBox, panel), osd);
  el.dataset.layout = layout;

  // ---- layout -----------------------------------------------------------------
  function sizeVideo() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (mini) {
      // Docked bottom right: sized by the shorter side, so it stays a sensible
      // size from 4:3 to 32:9 and at any resolution.
      const w = Math.round(Math.min(W * 0.28, H * 0.5));
      const hgt = Math.round((w * 9) / 16);
      const margin = Math.round(H * 0.035);
      videoBox.style.width = `${w}px`;
      videoBox.style.height = `${hgt}px`;
      videoBox.style.left = `${W - w - margin}px`;
      videoBox.style.top = `${H - hgt - margin}px`;
      player?.setSize?.(w, hgt);
      cropInset = 0;
      if (hooked) hookEmbed();
      return;
    }
    const panelW = layout === "split" ? Math.max(W * 0.24, Math.min(W - (H * 16) / 9, W * 0.42)) : 0;
    const availW = W - panelW;
    let w = availW;
    let hgt = (w * 9) / 16;
    if (hgt > H) {
      hgt = H;
      w = (H * 16) / 9;
    }
    const z = fillZoom(W, H);
    w *= z;
    hgt *= z;
    videoBox.style.width = `${Math.round(w)}px`;
    videoBox.style.height = `${Math.round(hgt)}px`;
    // Split: video hugs the left; panel takes the rest. Theater: centered.
    videoBox.style.left = layout === "split" ? `${Math.round(Math.max(0, (availW - w) / 2))}px` : `${Math.round((W - w) / 2)}px`;
    videoBox.style.top = `${Math.round((H - hgt) / 2)}px`;
    panel.style.width = `${Math.round(panelW)}px`;
    player?.setSize?.(Math.round(w), Math.round(hgt));
    // Rows of the player cropped off the top and bottom of the screen.
    cropInset = Math.max(0, (Math.round(hgt) - H) / 2);
    if (hooked) hookEmbed();
  }

  // ---- embed hook (desktop app) ---------------------------------------------------
  let cropInset = 0;
  let hookTimer = 0;
  const playerFrame = (): HTMLIFrameElement | null => player?.getIframe?.() ?? null;
  function hookEmbed() {
    playerFrame()?.contentWindow?.postMessage({ panorama: "hook", inset: cropInset, quality: qualityPick }, YT_ORIGIN);
  }
  /** The embed script may load after the player: keep asking for a while. */
  function startHook() {
    if (!isTauri) return;
    clearInterval(hookTimer);
    let tries = 0;
    hookEmbed();
    hookTimer = window.setInterval(() => (hooked || ++tries > 20 ? clearInterval(hookTimer) : hookEmbed()), 500);
  }
  const onEmbedMessage = (e: MessageEvent) => {
    const frame = playerFrame();
    if (e.origin !== YT_ORIGIN || !frame || e.source !== frame.contentWindow) return;
    const d = e.data;
    if (!d || typeof d !== "object" || typeof d.panorama !== "string") return;
    if (d.panorama === "hooked") {
      hooked = true;
      clearInterval(hookTimer);
    } else if (d.panorama === "settings") {
      // YouTube's gear, clicked: show Panorama's menu instead.
      refocusApp();
      togglePlaybackSettings();
    } else if (d.panorama === "captions") {
      captionsOn = !!d.on;
      if (captionsOn) applyCaptionSize();
    } else if (d.panorama === "quality" && Array.isArray(d.list)) {
      qualities = d.list.filter((q: any) => typeof q?.quality === "string" && typeof q?.label === "string");
      qualityNow = typeof d.current === "string" ? d.current : "";
    }
  };

  /** Auto, then lowest to best, so ▶ goes up in quality. */
  function setQuality(d: 1 | -1) {
    const opts = ["auto", ...qualities.map((q) => q.quality).reverse()];
    const i = Math.max(0, Math.min(opts.length - 1, opts.indexOf(qualityPick) + d));
    qualityPick = opts[i];
    playerFrame()?.contentWindow?.postMessage({ panorama: "quality", quality: qualityPick }, YT_ORIGIN);
  }

  /** YouTube's caption font scale: -1 is its smallest, 0 its default. */
  const CAPTION_SCALE: Record<Settings["captionSize"], number> = { small: -1, medium: 0, large: 1 };
  const CAPTION_LABEL: Record<Settings["captionSize"], string> = { small: "Small", medium: "Medium", large: "Large" };
  const CAPTION_SIZES: Settings["captionSize"][] = ["small", "medium", "large"];
  function applyCaptionSize() {
    player?.setOption?.("captions", "fontSize", CAPTION_SCALE[settings().captionSize]);
  }

  function setCaptions(on: boolean) {
    captionsOn = on;
    if (hooked) playerFrame()?.contentWindow?.postMessage({ panorama: "captions", on }, YT_ORIGIN);
    else if (on) {
      // Loading the module alone doesn't always pick a track: choose the
      // viewer's language (YouTube falls back to auto-captions).
      player?.loadModule?.("captions");
      const lang = (navigator.language || "en").split("-")[0];
      setTimeout(() => {
        player?.setOption?.("captions", "track", { languageCode: lang });
        applyCaptionSize();
      }, 700);
    } else player?.unloadModule?.("captions");
    // Without the hook, zoom out so the captions aren't cropped.
    if (!hooked) {
      const from = videoBox.getBoundingClientRect();
      sizeVideo();
      flip(videoBox, from);
    }
    cue(on ? "toggleOn" : "toggleOff");
  }

  function setLayout(l: Layout) {
    const from = videoBox.getBoundingClientRect();
    layout = l;
    el.dataset.layout = l;
    if (l === "theater" && focus === "queue") setFocus("video");
    sizeVideo();
    flip(videoBox, from);
  }

  const onResize = () => sizeVideo();

  // ---- account actions -----------------------------------------------------------
  /** From YouTube's watch page for `current`; null until it arrives. */
  let details: api.WatchDetails | null = null;
  let liked = false;
  let subscribed: boolean | null = null;

  function syncActions() {
    const set = (b: HTMLElement, label: string, on: boolean, disabled = false) => {
      b.querySelector("span")!.textContent = label;
      b.classList.toggle("on", on);
      (b as HTMLButtonElement).disabled = disabled;
    };
    set(likeBtn, liked ? "Liked" : "Like", liked);
    set(saveBtn, "Save", false);
    set(commentsBtn, details?.commentsText ? `Comments · ${details.commentsText}` : "Comments", false, !!details && !details.commentsToken);
    set(subBtn, subscribed ? "Subscribed" : "Subscribe", !!subscribed, !current.channelId || subscribed === null);
  }

  async function toggleLike() {
    const v = current;
    const on = !liked;
    liked = on;
    syncActions();
    cue(on ? "toggleOn" : "toggleOff");
    try {
      await api.setLiked(v.id, on);
      toast(on ? "Added to Liked videos" : "Removed from Liked videos", "success");
    } catch (e) {
      if (current.id === v.id) ((liked = !on), syncActions());
      toast(`Couldn't update the like: ${e instanceof Error ? e.message : e}`, "error", 5000);
    }
  }

  async function toggleSubscribe() {
    const v = current;
    if (!v.channelId || subscribed === null) return;
    const on = !subscribed;
    subscribed = on;
    syncActions();
    cue(on ? "toggleOn" : "toggleOff");
    try {
      await api.setSubscribed(v.channelId, on, v.id, on ? details?.subscribeParams : details?.unsubscribeParams);
      toast(on ? `Subscribed to ${v.channelTitle}` : `Unsubscribed from ${v.channelTitle}`, "success");
    } catch (e) {
      if (current.id === v.id) ((subscribed = !on), syncActions());
      toast(`Couldn't update the subscription: ${e instanceof Error ? e.message : e}`, "error", 5000);
    }
  }

  function showComments() {
    if (details?.commentsToken) openComments(details.commentsToken, details.commentsText);
    else toast(details ? "Comments are turned off for this video" : "Comments are still loading");
  }

  // ---- now playing ---------------------------------------------------------------
  function renderInfo() {
    titleEl.textContent = decodeEntities(current.title);
    channelBtn.textContent = current.channelTitle;
    lineEl.textContent = [current.viewsText, current.ageText].filter(Boolean).join("  ·  ");
    descEl.textContent = current.description;
    descEl.scrollTop = 0;
    ambient.style.backgroundImage = `url("${current.thumb}")`;
    setBackdrop(null);
    details = null;
    liked = false;
    subscribed = null;
    syncActions();
    renderQueue();
    loadDetails(current);
  }

  /** Full description, and related videos to fill Up next when it's short. */
  function loadDetails(v: api.Video) {
    api
      .watchNext(v.id)
      .then((d) => {
        if (destroyed || current.id !== v.id) return;
        const { description, related } = d;
        details = d;
        liked = d.liked;
        subscribed = d.subscribed;
        syncActions();
        if (description) descEl.textContent = description;
        const known = new Set(queue.map((q) => q.id));
        const fresh = related.filter((r) => !known.has(r.id));
        if (pos >= queue.length - 3 && fresh.length) {
          queue = [...queue, ...fresh.slice(0, 20)];
          renderQueue();
        }
      })
      .catch(() => {});
  }

  function renderQueue() {
    queueEl.replaceChildren(
      ...queue.map((v, i) => {
        const item = h(
          `div.q-item${i === pos ? ".playing" : ""}`,
          { onclick: () => playAt(i) },
          h("div.q-thumb", { style: `background-image:url("${v.thumb}")` }, h("span.badge", null, v.live ? "LIVE" : fmtDuration(v.durationSec))),
          h("div.q-meta", null, h("div.q-title", null, decodeEntities(v.title)), h("div.q-sub", null, v.channelTitle)),
        );
        return item;
      }),
    );
    syncQueueFocus();
  }

  function syncQueueFocus() {
    const items = queueEl.children;
    for (let i = 0; i < items.length; i++) items[i].classList.toggle("focused", focus === "queue" && i === qIdx);
    const target = (items[focus === "queue" ? qIdx : pos] as HTMLElement | undefined) ?? null;
    if (target) {
      const top = target.offsetTop - queueEl.clientHeight * 0.35;
      queueEl.scrollTo({ top, behavior: settings().reducedMotion ? "auto" : "smooth" });
    }
  }

  // ---- playback settings (☰) ------------------------------------------------------
  // YouTube's own gear menu needs a mouse; this is the controller version, and
  // in the desktop app YouTube's gear opens it too. Mouse: hover to focus,
  // click a row or its ◀ ▶ arrows, click outside to close.
  const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const QUALITY: Record<string, string> = {
    highres: "Above 4K", hd2160: "2160p (4K)", hd1440: "1440p", hd1080: "1080p", hd720: "720p",
    large: "480p", medium: "360p", small: "240p", tiny: "144p",
  };
  let psOpen = false;

  function togglePlaybackSettings() {
    if (psOpen) router.closeOverlay();
    else openPlaybackSettings();
  }

  function openPlaybackSettings() {
    let idx = 0;
    const rate = () => player?.getPlaybackRate?.() ?? 1;
    const leave = (run: () => void) => () => {
      router.closeOverlay();
      run();
    };
    const rows: { label: string; value?: () => string; help: string; select?: () => void; adjust?: (d: 1 | -1) => void }[] = [
      {
        label: "Save to playlist",
        help: "Save this video to Watch later or one of your playlists, or remove it.",
        select: leave(() => openSaveTo(current)),
      },
      {
        label: "Like",
        value: () => (liked ? "Liked" : "—"),
        help: "Like this video. It shows up in Liked videos in your Library.",
        select: () => void toggleLike(),
      },
      {
        label: "Comments",
        value: () => details?.commentsText ?? "",
        help: "Read what people are saying about this video.",
        select: leave(showComments),
      },
      {
        label: "Subscribe",
        value: () => (subscribed === null ? "" : subscribed ? "Subscribed" : "—"),
        help: `Subscribe to ${current.channelTitle || "this channel"}. New uploads appear in Subscriptions and on Home.`,
        select: () => void toggleSubscribe(),
      },
      {
        label: "Captions",
        value: () => (captionsOn ? "On" : "Off"),
        help: "Subtitles in the video's language, or YouTube's automatic captions. C on the keyboard also switches them.",
        select: () => setCaptions(!captionsOn),
      },
      {
        label: "Caption size",
        value: () => CAPTION_LABEL[settings().captionSize],
        help: "How big subtitles are drawn over the video. Use ◀ ▶ to change.",
        adjust: (d) => {
          const i = Math.max(0, Math.min(CAPTION_SIZES.length - 1, CAPTION_SIZES.indexOf(settings().captionSize) + d));
          updateSettings({ captionSize: CAPTION_SIZES[i] });
          applyCaptionSize();
        },
      },
      {
        label: "Speed",
        value: () => (rate() === 1 ? "Normal" : `${rate()}×`),
        help: "Playback speed. Use ◀ ▶ to change.",
        adjust: (d) => {
          const i = Math.max(0, Math.min(RATES.length - 1, RATES.indexOf(rate()) + d));
          player?.setPlaybackRate?.(RATES[i < 0 ? 3 : i]);
        },
      },
      hooked && qualities.length
        ? {
            // The embed script lists YouTube's own qualities, HDR ones
            // included ("1080p HDR"), and applies the pick.
            label: "Quality",
            value: () => {
              const picked = qualities.find((q) => q.quality === qualityPick)?.label;
              return picked ?? `Auto${qualityNow ? ` · ${qualityNow}` : ""}`;
            },
            help: "Every quality YouTube offers for this video, HDR included when your display has HDR on. Auto lets YouTube choose. Use ◀ ▶ to change.",
            adjust: setQuality,
          }
        : {
            // Display only: without the embed hook, embedded players can't be
            // told a quality (YouTube ignores the request). The player is sized
            // to the screen, which is what YouTube's automatic choice is based on.
            label: "Quality",
            value: () => `Auto${QUALITY[player?.getPlaybackQuality?.() ?? ""] ? ` · ${QUALITY[player.getPlaybackQuality()]}` : ""}`,
            help: "YouTube picks the quality automatically from the player's size and your connection. Panorama sizes the player to your screen, so it streams the best quality your display can show.",
          },
      {
        label: "Fill ultrawide screens",
        value: () => (settings().ultrawideFill ? "On" : "Off"),
        help: "Zoom the video to fill an ultrawide screen (full layout). Captions and controls stay in view.",
        select: () => {
          updateSettings({ ultrawideFill: !settings().ultrawideFill });
          const from = videoBox.getBoundingClientRect();
          sizeVideo();
          flip(videoBox, from);
          cue(settings().ultrawideFill ? "toggleOn" : "toggleOff");
        },
      },
      {
        label: "Layout",
        value: () => (layout === "split" ? "Side panel" : "Full"),
        help: "Show the info and Up next panel beside the video, or the video alone. Ⓨ also switches.",
        select: () => setLayout(layout === "split" ? "theater" : "split"),
        adjust: () => setLayout(layout === "split" ? "theater" : "split"),
      },
      {
        label: "Up next",
        help: "Browse what plays next.",
        select: () => {
          router.closeOverlay();
          if (layout === "theater") setLayout("split");
          setFocus("queue");
        },
      },
      {
        label: "Panorama settings",
        help: "Sounds, startup, controller and app settings. Leaves this video.",
        select: () => {
          router.closeOverlay();
          router.showTab("settings");
        },
      },
    ];

    const list = h("div.ps-list");
    const help = h("p.ps-help");
    const activate = (i: number) => {
      const r = rows[i];
      if (r.select) r.select();
      else if (r.adjust) (r.adjust(1), cue("sliderUp"));
    };
    const els = rows.map((r, i) => {
      const value = h("span.s-value");
      if (r.adjust) {
        const arrow = (d: 1 | -1) =>
          h(
            "button.ps-arrow",
            {
              onclick: (ev: Event) => {
                ev.stopPropagation();
                idx = i;
                r.adjust!(d);
                cue(d < 0 ? "sliderDown" : "sliderUp");
                sync();
              },
            },
            d < 0 ? "◀" : "▶",
          );
        value.append(arrow(-1), h("span.ps-val"), arrow(1));
      }
      const row = h(
        `div.s-row${r.select || r.adjust ? "" : ".static"}`,
        {
          onclick: () => {
            idx = i;
            activate(i);
            sync();
          },
          onmousemove: () => {
            if (idx !== i && pointerIsActive()) ((idx = i), sync());
          },
        },
        h("span.s-label", null, r.label),
        value,
      );
      list.append(row);
      return row;
    });
    const sync = () => {
      els.forEach((el, i) => {
        el.classList.toggle("focused", i === idx);
        const v = rows[i].value?.() ?? "";
        if (rows[i].adjust) el.querySelector(".ps-val")!.textContent = v;
        else el.querySelector(".s-value")!.textContent = v;
      });
      help.textContent = rows[idx].help;
    };
    const el: HTMLElement = h(
      "div.overlay.playback-settings",
      // Click outside the card closes it.
      {
        onclick: (ev: Event) => {
          if (ev.target === el) router.closeOverlay();
        },
      },
      h("div.ps-panel", null, h("h2", null, "Video"), list, help, h("p.te-legend", null, "Ⓐ select   ◀ ▶ change   Ⓑ / ☰ close   ·   Mouse: click, or click outside to close")),
    );
    sync();
    // Values like quality and speed settle a moment after a change.
    const refresh = window.setInterval(sync, 500);
    psOpen = true;
    router.openOverlay({
      el,
      onClose: () => {
        psOpen = false;
        clearInterval(refresh);
      },
      onAction(e: ActionEvent) {
        const r = rows[idx];
        if (e.action === "up") idx = Math.max(0, idx - 1);
        else if (e.action === "down") idx = Math.min(rows.length - 1, idx + 1);
        else if (e.action === "left" || e.action === "right") {
          if (!r.adjust) return true;
          r.adjust(e.action === "left" ? -1 : 1);
          cue(e.action === "left" ? "sliderDown" : "sliderUp");
        } else if (e.action === "select") activate(idx);
        else if (e.action === "menu") {
          router.closeOverlay();
          return true;
        } else return false;
        sync();
        return true;
      },
    });
  }

  function setFocus(f: "video" | "queue") {
    focus = f;
    el.classList.toggle("queue-focus", f === "queue");
    qIdx = f === "queue" ? Math.min(queue.length - 1, pos + 1) : qIdx;
    syncQueueFocus();
  }

  function tickProgress() {
    if (!player?.getCurrentTime) return;
    const t = pendingSeek ?? player.getCurrentTime();
    const d = player.getDuration() || current.durationSec;
    timeEl.textContent = d ? `${fmtDuration(t) || "0:00"} / ${fmtDuration(d)}` : "";
    barFill.style.transform = `scaleX(${d ? Math.min(1, t / d) : 0})`;
    stateEl.textContent =
      state === State.Playing ? "Playing" : state === State.Paused ? "Paused" : state === State.Buffering ? "Buffering…" : "";
  }

  // Transient indicator. Kept small and short-lived; in split layout the panel
  // shows the same information, so the OSD only appears in theater layout.
  let osdTimer = 0;
  function flash(text: string) {
    if (layout === "split") return;
    osd.textContent = text;
    osd.classList.add("show");
    clearTimeout(osdTimer);
    osdTimer = window.setTimeout(() => osd.classList.remove("show"), 900);
  }

  // ---- playback -------------------------------------------------------------------
  async function create() {
    try {
      const YT = await loadIframeApi();
      if (destroyed) return;
      const events = {
        onReady: () => {
          if (adopted) {
            player.unMute();
            player.setVolume(100);
          }
          player.playVideo();
          refocusApp();
          startHook();
        },
        onStateChange: (e: any) => {
          state = e.data;
          el.classList.toggle("playing", state === State.Playing);
          if (state === State.Playing) rezoomTimer = window.setTimeout(() => setUnzoomed(false), 600);
          else if (state !== State.Buffering) setUnzoomed(true);
          if (state === State.Ended) onEnded();
          tickProgress();
        },
        onError: (e: any) => onError(e.data),
      };
      // Netflix-style continuation: adopt the playing preview. `moveBefore`
      // moves an iframe without reloading it; elsewhere, start fresh below.
      const adopted = !!handoff && handoff.isConnected && "moveBefore" in Element.prototype;
      if (adopted) {
        (videoBox as any).moveBefore(handoff, host);
        host.remove();
        handoff!.className = "";
        player = new AdoptedPlayer(handoff!, events, startAt);
        sizeVideo();
        events.onReady();
        // The preview was playing; the player only reports changes, so it won't
        // say so again. Start from "playing".
        events.onStateChange({ data: State.Playing });
        progressTimer = window.setInterval(tickProgress, 250);
        return;
      }
      handoff?.remove();
      player = new YT.Player(host, {
        videoId: current.id,
        width: videoBox.clientWidth,
        height: videoBox.clientHeight,
        playerVars: {
          // Continue a preview: whole seconds, a moment early so nothing is missed.
          start: Math.max(0, Math.floor(startAt) - 1),
          autoplay: 1,
          controls: 1,
          rel: 0,
          fs: 0,
          playsinline: 1,
          iv_load_policy: 3,
          enablejsapi: 1,
          origin: location.origin,
          hl: navigator.language,
        },
        events,
      });
      progressTimer = window.setInterval(tickProgress, 250);
    } catch (e) {
      toast(String(e instanceof Error ? e.message : e), "error");
    }
  }

  function playAt(i: number) {
    if (i < 0 || i >= queue.length) return;
    clearTimeout(autoNext);
    pos = i;
    qIdx = i;
    current = queue[i];
    pendingSeek = null;
    errored = false;
    player?.loadVideoById?.(current.id);
    renderInfo();
  }

  function onEnded() {
    if (!settings().autoplayNext || pos >= queue.length - 1) return;
    let n = 5;
    const step = () => {
      stateEl.textContent = `Next video in ${n}…`;
      flash(`Up next in ${n}`);
      if (n-- <= 0) playAt(pos + 1);
      else autoNext = window.setTimeout(step, 1000);
    };
    step();
  }

  function onError(code: number) {
    errored = true;
    const embedBlocked = code === 101 || code === 150 || code === 153;
    if (embedBlocked && isTauri) {
      // Some creators only allow playback on youtube.com: play it there, in
      // Panorama's YouTube view, and continue the queue when the user comes back.
      toast("This video only plays on YouTube — opening it there");
      openWatchView(current.id);
      return;
    }
    toast(code === 100 ? "This video is unavailable." : `Playback error (${code}).`, "error", 5000);
    if (pos < queue.length - 1) autoNext = window.setTimeout(() => playAt(pos + 1), 4000);
  }

  let viewOpen = false;
  let unlistenView: () => void = () => {};
  function openWatchView(id: string) {
    if (viewOpen) return;
    viewOpen = true;
    player?.pauseVideo?.();
    openYouTube(`/watch?v=${id}`).catch((e) => {
      viewOpen = false;
      toast(String(e), "error");
    });
    unlistenView();
    listen("ytview-closed", () => {
      if (!viewOpen || destroyed) return;
      viewOpen = false;
      if (errored && pos < queue.length - 1) playAt(pos + 1);
    }).then((off) => (unlistenView = off));
  }

  function seekBy(delta: number) {
    if (!player?.getCurrentTime) return;
    const d = player.getDuration() || Infinity;
    pendingSeek = Math.min(Math.max(0, (pendingSeek ?? player.getCurrentTime()) + delta), d - 1);
    cue(delta > 0 ? "sliderUp" : "sliderDown");
    flash(`${delta > 0 ? "▶▶" : "◀◀"}  ${fmtDuration(pendingSeek) || "0:00"}`);
    tickProgress();
    clearTimeout(seekCommit);
    seekCommit = window.setTimeout(() => {
      if (pendingSeek !== null) player.seekTo(pendingSeek, true);
      pendingSeek = null;
    }, 140);
  }

  function changeVolume(delta: number) {
    if (!player?.getVolume) return;
    const v = Math.min(100, Math.max(0, player.getVolume() + delta));
    player.setVolume(v);
    cue("volume");
    if (v > 0 && player.isMuted()) player.unMute();
    flash(`Volume ${v}`);
    stateEl.textContent = `Volume ${v}`;
  }

  // Clicking the player moves keyboard focus into its cross-origin iframe, where
  // our key handlers can't see it. Hand focus back to the app right after.
  const onBlur = () => {
    // A click went into the player: show it whole for a moment (only needed
    // when the hook can't keep YouTube's controls inside the visible area).
    if (document.activeElement?.tagName === "IFRAME" && settings().ultrawideFill && !hooked) {
      setUnzoomed(true);
      rezoomTimer = window.setTimeout(() => state === State.Playing && setUnzoomed(false), 5000);
    }
    setTimeout(refocusApp, 0);
  };
  function refocusApp() {
    if (document.activeElement?.tagName === "IFRAME") (document.activeElement as HTMLElement).blur();
    window.focus();
  }

  // PC shortcuts (YouTube's own keys), on top of the shared arrow/Enter/Esc mapping.
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
    const k = e.key.toLowerCase();
    if (psOpen && k !== "s") return;
    const handled = (() => {
      switch (k) {
        case "k":
          if (!e.repeat) togglePlay();
          return true;
        case "j":
          seekBy(-10);
          return true;
        case "l":
          seekBy(10);
          return true;
        case "m":
          if (!e.repeat) toggleMute();
          return true;
        case "c":
          if (!e.repeat) (setCaptions(!captionsOn), flash(captionsOn ? "Captions on" : "Captions off"));
          return true;
        case "s":
          if (!e.repeat) togglePlaybackSettings();
          return true;
        case "f":
          if (!e.repeat) isFullscreen().then((fs) => setFullscreen(!fs));
          return true;
      }
      return false;
    })();
    if (handled) e.preventDefault();
  };
  // Right-click anywhere outside the video opens the playback menu.
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    togglePlaybackSettings();
  };

  function togglePlay() {
    if (state === State.Playing) player?.pauseVideo();
    else player?.playVideo();
    flash(state === State.Playing ? "❚❚ Paused" : "▶ Play");
  }

  function toggleMute() {
    if (player?.isMuted?.()) (player.unMute(), flash("Sound on"));
    else (player?.mute?.(), flash("Muted"));
  }

  renderInfo();

  // Input listeners: only while full screen. Resize and embed messages also
  // run while docked as a miniplayer.
  function attachInput() {
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKey);
    el.addEventListener("contextmenu", onContextMenu);
  }
  function detachInput() {
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("keydown", onKey);
    el.removeEventListener("contextmenu", onContextMenu);
  }

  return {
    el,
    immersive: true,
    minimize(on: boolean) {
      const from = videoBox.getBoundingClientRect();
      mini = on;
      el.classList.toggle("mini", on);
      if (on) {
        detachInput();
        if (focus === "queue") setFocus("video");
      } else attachInput();
      sizeVideo();
      flip(videoBox, from);
    },
    onShow() {
      sizeVideo();
      window.addEventListener("resize", onResize);
      window.addEventListener("message", onEmbedMessage);
      attachInput();
      if (!player) requestAnimationFrame(() => create());
      else if (resumeOnShow) player.playVideo?.();
      resumeOnShow = false;
    },
    onHide() {
      // Covered by another screen (e.g. the channel page): don't keep playing unseen.
      if (!destroyed && state === State.Playing) {
        resumeOnShow = true;
        player?.pauseVideo?.();
      }
      window.removeEventListener("resize", onResize);
      window.removeEventListener("message", onEmbedMessage);
      detachInput();
    },
    onDestroy() {
      destroyed = true;
      unlistenView();
      clearInterval(progressTimer);
      clearTimeout(autoNext);
      clearTimeout(seekCommit);
      clearInterval(hookTimer);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("message", onEmbedMessage);
      detachInput();
      try {
        player?.destroy?.();
      } catch {
        /* iframe already gone */
      }
    },
    onAction(e: ActionEvent) {
      if (focus === "queue") {
        switch (e.action) {
          case "up":
            qIdx = Math.max(0, qIdx - 1);
            syncQueueFocus();
            return true;
          case "down":
            qIdx = Math.min(queue.length - 1, qIdx + 1);
            syncQueueFocus();
            return true;
          case "select":
            playAt(qIdx);
            setFocus("video");
            return true;
          case "alt":
            openChannel(queue[qIdx].channelId);
            return true;
          case "back":
          case "menu":
          case "left":
            setFocus("video");
            return true;
        }
      }
      const repeatBoost = 1 + Math.min(5, Math.floor(e.count / 4));
      switch (e.action) {
        case "select":
          togglePlay();
          return true;
        case "left":
          seekBy(-10 * repeatBoost);
          return true;
        case "right":
          seekBy(10 * repeatBoost);
          return true;
        case "rewind":
          seekBy(-30 * repeatBoost);
          return true;
        case "forward":
          seekBy(30 * repeatBoost);
          return true;
        case "up":
          changeVolume(5);
          return true;
        case "down":
          changeVolume(-5);
          return true;
        case "prevTab":
          // Like a TV remote: restart if we're past the intro, else previous.
          if ((player?.getCurrentTime?.() ?? 0) > 5 || pos === 0) player?.seekTo?.(0, true);
          else playAt(pos - 1);
          return true;
        case "nextTab":
          playAt(pos + 1);
          return true;
        case "search":
          setLayout(layout === "split" ? "theater" : "split");
          return true;
        case "menu":
          togglePlaybackSettings();
          return true;
        case "alt":
          if (errored) openWatchView(current.id);
          else toggleMute();
          return true;
        case "info":
          openChannel(current.channelId);
          return true;
      }
      return false;
    },
  };
}
