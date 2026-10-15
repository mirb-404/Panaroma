// Injected into every frame of Panorama's main window; it only acts inside
// YouTube's embedded player and stays dormant until the parent page asks.
// "preview" (or #panorama-preview in the URL): a muted hover preview. All of
// YouTube's overlays (play/pause icons, spinner, controls, title bar) are
// hidden, so the preview can fade in the moment it plays.
// "hook": the full player (also sent when a preview is handed over to it,
// which brings the overlays back). Once hooked:
//  - the player's gear button opens Panorama's playback menu instead of
//    YouTube's (which needs a mouse and offers nothing the app doesn't);
//  - captions and the control bar are kept inside the visible area when
//    "Fill ultrawide screens" crops the top and bottom of the player.
// Only stable hooks are used (ytp-* class names that have been unchanged for
// years); if they ever change, the player simply behaves like a normal embed.
(() => {
  if (location.hostname !== "www.youtube.com" || !location.pathname.startsWith("/embed/")) return;
  if (window.top === window || window.__panoramaEmbed) return;
  window.__panoramaEmbed = true;

  const parentOrigin = (location.ancestorOrigins && location.ancestorOrigins[0]) || "*";
  const send = (type, extra) => parent.postMessage({ panorama: type, ...extra }, parentOrigin);
  let hooked = false;
  let inset = 0;

  // Previews show the picture only: every layer of YouTube's UI (control bar,
  // play/pause bezel, spinner, title, unmute button, end screens) is a sibling
  // of the video container, so hiding all of those siblings covers new overlay
  // types too. Previews are marked in their URL (#panorama-preview), so this
  // applies from the very first frame instead of after a handshake.
  const previewStyle = document.createElement("style");
  const setPreview = (on) => {
    previewStyle.textContent = on
      ? `.html5-video-player > :not(.html5-video-container), .ytp-bezel, .ytp-spinner, .ytp-large-play-button,
         .ytp-pause-overlay, .ytp-chrome-top, .ytp-chrome-bottom, .ytp-gradient-top, .ytp-gradient-bottom
         { display: none !important; }`
      : "";
  };
  const markedPreview = location.hash.includes("panorama-preview");
  setPreview(markedPreview);

  const style = document.createElement("style");
  // While hooked, YouTube's own settings menu never shows (Panorama's opens
  // instead), even if a player update opens it from a control we don't catch.
  const HOOKED_CSS = `.ytp-settings-menu, .ytp-popup.ytp-settings-menu { display: none !important; }`;
  const applyInset = () => {
    const px = Math.max(0, Math.round(inset));
    const crop = px
      ? `.ytp-caption-window-container { top: ${px}px !important; height: calc(100% - ${2 * px}px) !important; }
         .ytp-chrome-bottom, .ytp-gradient-bottom { bottom: ${px}px !important; }
         .ytp-chrome-top, .ytp-gradient-top { top: ${px}px !important; }`
      : "";
    style.textContent = hooked ? HOOKED_CSS + crop : "";
  };
  const mount = () => {
    (document.head || document.documentElement).append(style, previewStyle);
    if (markedPreview) send("preview-ready");
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();

  // The gear: swallow every event YouTube might open its menu on, and ask the
  // app for its own menu on click (or keyboard activation).
  const onGear = (e) => e.target instanceof Element && e.target.closest(".ytp-settings-button");
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "touchstart", "touchend", "click"]) {
    addEventListener(
      type,
      (e) => {
        if (!hooked || !onGear(e)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (type === "click") send("settings");
      },
      true,
    );
  }
  addEventListener(
    "keydown",
    (e) => {
      if (!hooked || !onGear(e) || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      send("settings");
    },
    true,
  );

  // Captions: report YouTube's own CC state so the app's menu stays in sync.
  const ccButton = () => document.querySelector(".ytp-subtitles-button");
  let ccState = null;
  setInterval(() => {
    if (!hooked) return;
    const b = ccButton();
    const on = !!b && b.getAttribute("aria-pressed") === "true";
    if (on !== ccState) {
      ccState = on;
      send("captions", { on });
    }
  }, 500);

  addEventListener("message", (e) => {
    if (e.source !== parent || (parentOrigin !== "*" && e.origin !== parentOrigin)) return;
    const d = e.data;
    if (!d || typeof d !== "object" || typeof d.panorama !== "string") return;
    if (d.panorama === "preview") {
      setPreview(true);
      send("preview-ready");
    } else if (d.panorama === "hook") {
      setPreview(false);
      hooked = true;
      inset = Number(d.inset) || 0;
      applyInset();
      send("hooked", { captions: !!ccButton() });
    } else if (d.panorama === "captions") {
      const b = ccButton();
      const on = !!b && b.getAttribute("aria-pressed") === "true";
      if (b && on !== !!d.on) b.click();
    }
  });
})();
