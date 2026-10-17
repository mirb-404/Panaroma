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
import { applyScale, backButton, backdropEl, createClock, createRail, toast, toastHost } from "./ui/chrome";
import { playStartup } from "./ui/intro";
import { loadIframeApi } from "./screens/player";
import { signInFlow } from "./screens/common";
import { loadSounds } from "./sound";
import { confirmDialog } from "./ui/textentry";
import { detectDevice, showTutorial } from "./ui/tutorial";

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
  document.getElementById("app")!.append(backdropEl, stage, rail.el, overlays, toastHost, createClock(), backButton);

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
  Promise.all([startup, restored]).then(async () => {
    if (!signedIn() && canSignIn()) await signInFlow();
    welcome();
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
  onAuth((on) => {
    syncAvatar();
    router.resetAll();
    if (on) welcome();
  });

  router.showTab("home");
  warmUp();

  initPad();
  onPadStatus((e) => {
    if (e.type === "connected") toast(`${e.name} connected`);
    else if (e.type === "disconnected") toast("Controller disconnected");
  });

  // TV feel: the cursor disappears when it's not being used (and stays hidden
  // until the mouse first moves).
  document.body.classList.add("cursor-hidden");
  let idle = 0;
  window.addEventListener("mousemove", () => {
    document.body.classList.remove("cursor-hidden");
    clearTimeout(idle);
    idle = window.setTimeout(() => document.body.classList.add("cursor-hidden"), 2500);
  });
}

/**
 * First launch: once signed in (sign-in needs the desktop app, so the browser
 * build skips that), greet the user and tour the controls of the device in
 * use. It runs once; Settings → Controls replays it.
 */
let welcoming = false;
async function welcome() {
  if (welcoming || settings().tutorialSeen || (canSignIn() && !signedIn())) return;
  welcoming = true;
  // Let Home lay out its first row so the spotlight has something to point at.
  await new Promise((r) => setTimeout(r, 900));
  await showTutorial(await detectDevice(), { welcome: true });
  updateSettings({ tutorialSeen: true });
  welcoming = false;
}

/**
 * Makes the first preview and the first video start faster: connections to
 * YouTube's hosts are opened early, and the player code is downloaded once
 * (by an invisible, muted, paused player) so later players load from cache.
 */
function warmUp() {
  for (const href of ["https://www.youtube.com", "https://i.ytimg.com", "https://yt3.ggpht.com", "https://www.google.com"]) {
    const link = document.createElement("link");
    link.rel = "preconnect";
    link.href = href;
    document.head.append(link);
  }
  setTimeout(() => {
    loadIframeApi().catch(() => {});
    const params = new URLSearchParams({ autoplay: "0", mute: "1", controls: "1", rel: "0", playsinline: "1", enablejsapi: "1", origin: location.origin });
    const frame = document.createElement("iframe");
    frame.src = `https://www.youtube.com/embed/aqz-KE-bpKQ?${params}`;
    frame.tabIndex = -1;
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:320px;height:180px;opacity:0;pointer-events:none";
    document.body.append(frame);
    setTimeout(() => frame.remove(), 10_000);
  }, 1500);
}

main().catch((e) => {
  console.error(e);
  appReady();
  document.body.textContent = `Panorama failed to start: ${e}`;
});
