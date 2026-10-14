// Injected into Panorama's in-app YouTube view (youtube.com in its own window).
// It only touches the most stable hooks on the page — the HTML5 <video>
// element and a few container ids — so YouTube redesigns don't break it.
// It has no access to Panorama's IPC; closing works by navigating to a
// sentinel URL that the app intercepts.
(() => {
  if (location.hostname !== "www.youtube.com" || window.__panoramaView) return;
  window.__panoramaView = true;

  const close = () => (location.href = "https://panorama.invalid/close");
  const video = () => document.querySelector("video.html5-main-video") || document.querySelector("video");

  // Watch pages: the player fills the window (lean-back), everything else hidden.
  const css = `
    html.panorama-watch, html.panorama-watch body { overflow: hidden !important; background: #000 !important; }
    html.panorama-watch #masthead-container, html.panorama-watch #secondary, html.panorama-watch #below,
    html.panorama-watch ytd-mini-guide-renderer, html.panorama-watch tp-yt-app-drawer { display: none !important; }
    html.panorama-watch #movie_player {
      position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important;
      z-index: 2147483000 !important; background: #000 !important;
    }
    #panorama-hint {
      position: fixed; right: 24px; bottom: 24px; z-index: 2147483647; padding: 8px 16px; border-radius: 99px;
      background: rgba(0,0,0,.6); color: #fff; font: 600 15px "Segoe UI", sans-serif; pointer-events: none;
      transition: opacity .4s; opacity: 0;
    }`;
  const style = document.createElement("style");
  style.textContent = css;
  const hint = document.createElement("div");
  hint.id = "panorama-hint";
  hint.textContent = "Ⓑ / Esc  back to Panorama";
  let hintTimer = 0;
  const showHint = () => {
    hint.style.opacity = "1";
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => (hint.style.opacity = "0"), 2500);
  };

  const applyMode = () => {
    const watch = location.pathname === "/watch";
    document.documentElement.classList.toggle("panorama-watch", watch);
    // The player sizes itself on resize; nudge it after the layout change.
    [50, 300, 1000].forEach((t) => setTimeout(() => window.dispatchEvent(new Event("resize")), t));
  };
  const ready = () => {
    document.head.append(style);
    document.body.append(hint);
    applyMode();
    showHint();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else ready();
  document.addEventListener("yt-navigate-finish", applyMode);

  addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && !document.fullscreenElement) {
        e.preventDefault();
        close();
      }
    },
    true,
  );

  // Controller: the web Gamepad API (works for Xbox, PlayStation and more).
  const STD = { 0: "A", 1: "B", 4: "LB", 5: "RB", 6: "LT", 7: "RT", 9: "Menu", 12: "Up", 13: "Down", 14: "Left", 15: "Right" };
  const prev = new Map();
  const act = (b) => {
    const v = video();
    showHint();
    if (b === "B" || b === "Menu") return close();
    if (!v) return;
    if (b === "A") v.paused ? v.play() : v.pause();
    if (b === "Left") v.currentTime = Math.max(0, v.currentTime - 10);
    if (b === "Right") v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 10);
    if (b === "LT") v.currentTime = Math.max(0, v.currentTime - 30);
    if (b === "RT") v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 30);
    if (b === "Up") (v.muted = false), (v.volume = Math.min(1, v.volume + 0.05));
    if (b === "Down") v.volume = Math.max(0, v.volume - 0.05);
  };
  const poll = () => {
    if (document.hasFocus()) {
      for (const gp of navigator.getGamepads ? navigator.getGamepads() : []) {
        if (!gp || !gp.connected) continue;
        const now = new Set();
        gp.buttons.forEach((btn, i) => STD[i] && (btn.pressed || btn.value > 0.5) && now.add(STD[i]));
        const [lx = 0, ly = 0] = gp.axes;
        if (lx > 0.6) now.add("Right");
        if (lx < -0.6) now.add("Left");
        if (ly > 0.6) now.add("Down");
        if (ly < -0.6) now.add("Up");
        const was = prev.get(gp.index);
        if (was) for (const b of now) if (!was.has(b)) act(b);
        prev.set(gp.index, now);
      }
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
})();
