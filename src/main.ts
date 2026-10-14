import "./styles.css";
import { account } from "./api";
import { canSignIn, onAuth, restoreSession, signedIn } from "./auth";
import { h } from "./dom";
import { initPad, onPadStatus } from "./input";
import { appReady, isFullscreen, quitApp, setFullscreen } from "./platform";
import { router } from "./router";
import { searchScreen } from "./screens/search";
import { settingsScreen } from "./screens/settings";
import { homeScreen, libraryScreen, subscriptionsScreen } from "./screens/tabs";
import { loadSettings, settings, updateSettings } from "./settings";
import { applyScale, backdropEl, createClock, createRail, toast, toastHost } from "./ui/chrome";
import { playStartup } from "./ui/intro";
import { signInFlow } from "./screens/common";
import { loadSounds } from "./sound";
import { confirmDialog } from "./ui/textentry";

async function main() {
  await loadSettings();
  applyScale();
  let resizeRaf = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(applyScale);
  });
  loadSounds();

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
  if (settings().startFullscreen) setFullscreen(true).then(() => requestAnimationFrame(applyScale));
  const startup = playStartup();
  requestAnimationFrame(() => requestAnimationFrame(appReady));

  // First boot (or signed out): open Google's sign-in once the intro is done.
  // The session is remembered after that.
  const restored = restoreSession();
  Promise.all([startup, restored]).then(() => {
    if (!signedIn() && canSignIn()) signInFlow();
  });

  await restored;
  rail.setAvatar(settings().avatarUrl || null);
  const syncAvatar = () => {
    if (!signedIn()) {
      rail.setAvatar(null);
      updateSettings({ avatarUrl: "", accountName: "" });
      return;
    }
    account()
      .then((a) => {
        rail.setAvatar(a?.avatar || null);
        updateSettings({ avatarUrl: a?.avatar ?? "", accountName: a?.name ?? "" });
      })
      .catch(() => {});
  };
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
