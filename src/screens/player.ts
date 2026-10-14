// Playback through the official YouTube IFrame Player. Panorama never draws over
// the player's own surface during playback (YouTube API policy); on ultrawide
// screens the 16:9 video leaves pillarbox space, which hosts the info / up-next
// panel instead. Controller input drives the player through its public JS API.
import * as api from "../api";
import { decodeEntities, fmtDuration, h } from "../dom";
import type { ActionEvent } from "../input";
import { flip } from "../motion";
import { isTauri, listen, openYouTube } from "../platform";
import type { Screen } from "../router";
import { openChannel } from "../routes";
import { settings } from "../settings";
import { cue } from "../sound";
import { setBackdrop, toast } from "../ui/chrome";

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
  setSize(w: number, h: number) { this.frame.width = String(w); this.frame.height = String(h); }
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

  const ultra = () => window.innerWidth / window.innerHeight >= 2.0;
  // With "Fill ultrawide screens" on, ultrawide opens zoomed full-width; Ⓨ
  // switches to the side-panel layout.
  let layout: Layout = ultra() && !settings().ultrawideFill ? "split" : "theater";

  // Ultrawide fill: in theater layout the 16:9 player is zoomed (≤1.4×) to fill
  // the width, cropping top and bottom. It zooms out while paused and right
  // after a click into the player, so YouTube's controls stay reachable.
  const MAX_ZOOM = 1.4;
  let unzoomed = true; // until playback starts
  let rezoomTimer = 0;
  function fillZoom(W: number, H: number): number {
    if (layout !== "theater" || !settings().ultrawideFill || unzoomed) return 1;
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
  const videoBox = h("div.video-box", null, host);
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
  const legend = h(
    "div.legend",
    null,
    "Ⓐ play/pause   ◀ ▶ seek   ▲ ▼ volume   LB/RB prev/next   Ⓨ layout   ☰ up next   ⧉ channel   Ⓑ back",
  );
  const panel = h(
    "aside.np-panel",
    null,
    h("div.np-now", null, stateEl, timeEl, bar),
    titleEl,
    channelBtn,
    lineEl,
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

  // ---- now playing ---------------------------------------------------------------
  function renderInfo() {
    titleEl.textContent = decodeEntities(current.title);
    channelBtn.textContent = current.channelTitle;
    lineEl.textContent = [current.viewsText, current.ageText].filter(Boolean).join("  ·  ");
    descEl.textContent = current.description;
    descEl.scrollTop = 0;
    ambient.style.backgroundImage = `url("${current.thumb}")`;
    setBackdrop(null);
    renderQueue();
    loadDetails(current);
  }

  /** Full description, and related videos to fill Up next when it's short. */
  function loadDetails(v: api.Video) {
    api
      .watchNext(v.id)
      .then(({ description, related }) => {
        if (destroyed || current.id !== v.id) return;
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
    // A click went into the player: show it whole for a moment.
    if (document.activeElement?.tagName === "IFRAME" && settings().ultrawideFill) {
      setUnzoomed(true);
      rezoomTimer = window.setTimeout(() => state === State.Playing && setUnzoomed(false), 5000);
    }
    setTimeout(refocusApp, 0);
  };
  function refocusApp() {
    if (document.activeElement?.tagName === "IFRAME") (document.activeElement as HTMLElement).blur();
    window.focus();
  }

  renderInfo();

  return {
    el,
    immersive: true,
    onShow() {
      sizeVideo();
      window.addEventListener("resize", onResize);
      window.addEventListener("blur", onBlur);
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
      window.removeEventListener("blur", onBlur);
    },
    onDestroy() {
      destroyed = true;
      unlistenView();
      clearInterval(progressTimer);
      clearTimeout(autoNext);
      clearTimeout(seekCommit);
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
          if (state === State.Playing) player?.pauseVideo();
          else player?.playVideo();
          flash(state === State.Playing ? "❚❚ Paused" : "▶ Play");
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
          if (layout === "theater") setLayout("split");
          setFocus("queue");
          return true;
        case "alt":
          if (errored) openWatchView(current.id);
          else if (player?.isMuted?.()) (player.unMute(), flash("Sound on"));
          else (player?.mute?.(), flash("Muted"));
          return true;
        case "info":
          openChannel(current.channelId);
          return true;
      }
      return false;
    },
  };
}
