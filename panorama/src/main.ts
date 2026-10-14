import "./styles.css";
import { myChannel } from "./api";
import { onAuth, restoreSession, signedIn } from "./auth";
import { h } from "./dom";
import { initPad, onPadStatus } from "./input";
import { appReady, isFullscreen, quitApp, setFullscreen } from "./platform";
import { router } from "./router";
import { searchScreen } from "./screens/search";
import { settingsScreen } from "./screens/settings";
import { homeScreen, libraryScreen, subscriptionsScreen } from "./screens/tabs";
import { loadSettings, settings } from "./settings";
import { applyScale, backdropEl, createClock, createRail, toast, toastHost } from "./ui/chrome";
import { playIntro } from "./ui/intro";
import { confirmDialog } from "./ui/textentry";

async function main() {
  await loadSettings();
  applyScale();

  const rail = createRail();
  const stage = h("main.stage");
  const overlays = h("div.overlays");
  document.getElementById("app")!.append(backdropEl, stage, rail.el, overlays, toastHost, createClock());

  router.init(stage, overlays, rail, {
    home: homeScreen,
    subs: subscriptionsScreen,
    search: searchScreen,
    library: libraryScreen,
    settings: settingsScreen,
  });

  router.onGlobal = (e) => {
    if (e.action === "fullscreen" && !e.repeat) {
      isFullscreen().then((fs) => setFullscreen(!fs));
      return true;
    }
    if (e.action === "back" && router.railFocused) {
      confirmDialog("Exit Panorama?", "", "Exit", quitApp, "Stay");
      return true;
    }
    return false;
  };

  // The intro is the first frame the user sees; the app loads behind it.
  if (settings().startFullscreen) setFullscreen(true);
  playIntro();
  requestAnimationFrame(() => requestAnimationFrame(appReady));

  // Don't let a slow token refresh hold the first paint hostage.
  await Promise.race([restoreSession(), new Promise((r) => setTimeout(r, 2500))]);
  const syncAvatar = () =>
    signedIn() ? myChannel().then((c) => rail.setAvatar(c?.avatar ?? null)).catch(() => {}) : rail.setAvatar(null);
  syncAvatar();
  onAuth(() => {
    syncAvatar();
    router.resetAll();
  });

  router.showTab("home");

  initPad();
  onPadStatus((e) => {
    if (e.type === "connected") toast(`${e.name} connected`);
    else if (e.type === "disconnected") toast("Controller disconnected");
  });

  let resizeRaf = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(applyScale);
  });

  // TV feel: the cursor disappears when it's not being used.
  let idle = 0;
  window.addEventListener("mousemove", () => {
    document.body.classList.remove("cursor-hidden");
    clearTimeout(idle);
    idle = window.setTimeout(() => document.body.classList.add("cursor-hidden"), 2500);
  });
}

main().catch((e) => {
  console.error(e);
  appReady();
  document.body.textContent = `Panorama failed to start: ${e}`;
});
