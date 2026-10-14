// Startup ident: the mark pops in at center, glides left while the wordmark
// wipes in beside it, then the whole card lifts away into the app. It is an
// overlay, so the app loads underneath, and any button press skips it.
import { h } from "../dom";
import { fileSrc, isTauri } from "../platform";
import { router } from "../router";
import { settings } from "../settings";
import { cueWhenReady } from "../sound";

const POP = "cubic-bezier(.2, 1.45, .35, 1)";
const GLIDE = "cubic-bezier(.75, 0, .2, 1)";
const OUT = "cubic-bezier(.4, 0, .2, 1)";

/**
 * Plays whatever the user chose to see at launch. `preview` (from Settings)
 * plays it even when startup is set to Off.
 */
export async function playStartup(preview = false): Promise<void> {
  const mode = settings().startup;
  if (mode === "off" && !preview) return;
  if (mode === "video" && settings().startupVideo && isTauri) {
    const src = `${await fileSrc(settings().startupVideo)}?v=${settings().startupVideoVersion}`;
    if (await playVideo(src)) return;
  }
  // The bundled Panorama startup movie (tools/startup-video renders it).
  if (await playVideo(DEFAULT_MOVIE)) return;
  // Last resort if video can't play at all: the code-drawn ident.
  if (settings().reducedMotion && !preview) return;
  return playIdent();
}

const DEFAULT_MOVIE = "/startup/panorama-startup.webm";

/** Full-screen startup video. Resolves true once it played (or was skipped). */
async function playVideo(src: string): Promise<boolean> {
  const video = h("video.intro-video", { playsinline: true, preload: "auto" });
  const el = h("div.intro.intro-videohost", null, video, h("div.intro-skip", null, "Press any button to skip"));

  return new Promise((resolve) => {
    let done = false;
    const finish = (played: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(stall);
      const out = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: played ? 450 : 0, easing: OUT, fill: "forwards" });
      // Fade the soundtrack with the picture.
      const v0 = video.volume;
      const fade = setInterval(() => (video.volume = Math.max(0, video.volume - v0 / 9)), 50);
      out.onfinish = () => {
        clearInterval(fade);
        video.pause();
        video.removeAttribute("src");
        video.load();
        router.closeOverlay();
        resolve(played);
      };
    };
    // Unplayable file (codec, missing): fall back to the ident quickly.
    const stall = setTimeout(() => video.readyState < 2 && finish(false), 3000);
    video.addEventListener("ended", () => finish(true));
    video.addEventListener("error", () => finish(false));
    video.addEventListener("playing", () => clearTimeout(stall), { once: true });

    router.openOverlay({ el, onAction: () => (finish(true), true) }, { silent: true });
    el.addEventListener("click", () => finish(true));
    video.src = src;
    video.play().catch(() => finish(false));
  });
}

function playIdent(): Promise<void> {

  const mark = h("div.intro-mark", null, h("div.intro-glow"), h("div.logo-mark.intro-logo"));
  const word = h("div.intro-word", null, h("span", null, "Panorama"), h("span.intro-tv", null, "TV"));
  const stage = h("div.intro-stage", null, mark, word);
  const el = h("div.intro", null, stage);

  return new Promise((resolve) => {
    let done = false;
    const anims: Animation[] = [];
    const finish = () => {
      if (done) return;
      done = true;
      anims.forEach((a) => a.pause()); // freeze in place; the card fades as a whole
      const out = el.animate(
        [
          { opacity: 1, transform: "scale(1)" },
          { opacity: 0, transform: "scale(1.06)" },
        ],
        { duration: 420, easing: OUT, fill: "forwards" },
      );
      out.onfinish = () => {
        router.closeOverlay();
        resolve();
      };
    };

    router.openOverlay({ el, onAction: () => (finish(), true) }, { silent: true });
    el.addEventListener("click", finish);
    cueWhenReady("startup");

    // Layout is known now: the glide distance centers [mark + gap + wordmark].
    requestAnimationFrame(() => {
      const markW = mark.getBoundingClientRect().width;
      const wordW = word.getBoundingClientRect().width;
      const gap = parseFloat(getComputedStyle(stage).fontSize) * 1.6;
      const shift = -(gap + wordW) / 2;
      word.style.left = `calc(50% + ${shift + markW / 2 + gap}px)`;

      const run = (target: Element, frames: Keyframe[], o: KeyframeAnimationOptions) => {
        const a = target.animate(frames, { fill: "both", ...o });
        anims.push(a);
        return a;
      };

      run(mark, [
        { opacity: 0, transform: "translateX(0) scale(.55)" },
        { opacity: 1, transform: "translateX(0) scale(1)" },
      ], { duration: 650, easing: POP });
      run(mark.querySelector(".intro-glow")!, [
        { opacity: 0, transform: "scale(.6)" },
        { opacity: 0.9, transform: "scale(1.15)", offset: 0.45 },
        { opacity: 0.35, transform: "scale(1)" },
      ], { duration: 1300, easing: "ease-out" });
      run(mark, [
        { transform: "translateX(0) scale(1)" },
        { transform: `translateX(${shift}px) scale(1)` },
      ], { duration: 760, delay: 800, easing: GLIDE, fill: "forwards" }); // no backwards fill: it would mask the pop
      run(word, [
        { opacity: 0, clipPath: "inset(0 100% 0 0)", transform: "translateX(-1.6rem)" },
        { opacity: 1, clipPath: "inset(0 0% 0 0)", transform: "translateX(0)" },
      ], { duration: 640, delay: 1180, easing: GLIDE }); // starts once the mark has cleared
      run(word.querySelector(".intro-tv")!, [
        { opacity: 0, transform: "scale(.6)" },
        { opacity: 1, transform: "scale(1)" },
      ], { duration: 420, delay: 1620, easing: POP });

      setTimeout(finish, 2650);
    });
  });
}
