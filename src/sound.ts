// UI sounds. Two packs:
//  • "steam"    — Big Picture sounds read at runtime from the user's own Steam
//                 install (nothing of Valve's is bundled or redistributed);
//  • "panorama" — a built-in pack synthesized here with WebAudio (no files).
// Every interaction cues a sound; cues raised in the same tick collapse to the
// most important one (opening a video plays "launch", not "select" + "launch").
import { invoke, isTauri } from "./platform";
import { settings } from "./settings";

export type Cue =
  | "move" | "bump" | "select" | "type"
  | "sliderUp" | "sliderDown" | "volume" | "toggleOn" | "toggleOff"
  | "toast" | "tab" | "railIn" | "railOut" | "modalOpen" | "modalClose"
  | "open" | "back" | "launch" | "success" | "error" | "startup";

export type Pack = "steam" | "panorama" | "off";

const PRIORITY: Record<Cue, number> = {
  move: 0, bump: 1, select: 2,
  type: 3, sliderUp: 3, sliderDown: 3, volume: 3, toggleOn: 3, toggleOff: 3,
  toast: 4, tab: 5, railIn: 5, railOut: 5, modalOpen: 5, modalClose: 5,
  open: 6, back: 6, launch: 7, success: 7, error: 7, startup: 8,
};

const STEAM_FILES: Record<Cue, string> = {
  move: "deck_ui_navigation.wav",
  bump: "deck_ui_bumper_end_02.wav",
  select: "deck_ui_default_activation.wav",
  type: "deck_ui_typing.wav",
  sliderUp: "deck_ui_slider_up.wav",
  sliderDown: "deck_ui_slider_down.wav",
  volume: "deck_ui_volume.wav",
  toggleOn: "deck_ui_switch_toggle_on.wav",
  toggleOff: "deck_ui_switch_toggle_off.wav",
  toast: "deck_ui_toast.wav",
  tab: "deck_ui_tab_transition_01.wav",
  railIn: "deck_ui_side_menu_fly_in.wav",
  railOut: "deck_ui_side_menu_fly_out.wav",
  modalOpen: "deck_ui_show_modal.wav",
  modalClose: "deck_ui_hide_modal.wav",
  open: "deck_ui_into_game_detail.wav",
  back: "deck_ui_out_of_game_detail.wav",
  launch: "deck_ui_launch_game.wav",
  success: "confirmation_positive.wav",
  error: "confirmation_negative.wav",
  startup: "steam_os_startup.wav",
};

let ctx: AudioContext | null = null;
let master: GainNode;
let buffers = new Map<Cue, AudioBuffer>();
let loaded: Promise<Pack> = Promise.resolve("off");
let activePack: Pack = "off";

function audio(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: "interactive" });
    master = ctx.createGain();
    master.connect(ctx.destination);
    // In a plain browser the context starts suspended until a user gesture.
    const resume = () => ctx?.state === "suspended" && ctx.resume();
    window.addEventListener("keydown", resume, true);
    window.addEventListener("pointerdown", resume, true);
  }
  return ctx;
}

export function steamSoundsAvailable(): Promise<boolean> {
  return isTauri ? invoke<boolean>("steam_sounds_available").catch(() => false) : Promise.resolve(false);
}

/** Loads the selected pack; falls back to the built-in pack if Steam is missing. */
export function loadSounds(): Promise<Pack> {
  const want = settings().uiSounds;
  loaded = (async () => {
    if (want === "off") {
      buffers = new Map();
      return (activePack = "off");
    }
    const ac = audio();
    master.gain.value = settings().uiVolume;
    let pack: Pack = want;
    if (want === "steam" && !(await steamSoundsAvailable())) pack = "panorama";
    const next = new Map<Cue, AudioBuffer>();
    const cues = Object.keys(STEAM_FILES) as Cue[];
    await Promise.all(
      cues.map(async (c) => {
        try {
          if (pack === "steam") {
            const bytes = await invoke<ArrayBuffer>("read_steam_sound", { name: STEAM_FILES[c] });
            next.set(c, await ac.decodeAudioData(bytes));
          } else {
            next.set(c, await SYNTH[c]());
          }
        } catch {
          /* a missing sound just stays silent */
        }
      }),
    );
    buffers = next;
    return (activePack = pack);
  })();
  return loaded;
}

export function setSoundVolume(v: number) {
  if (ctx) master.gain.value = v;
}

export const currentPack = () => activePack;

// ---- cueing ----------------------------------------------------------------------

let pending: Cue | null = null;
let flushQueued = false;
const lastPlayed = new Map<Cue, number>();
const voices: AudioBufferSourceNode[] = [];

export function cue(c: Cue) {
  if (activePack === "off" && settings().uiSounds === "off") return;
  if (!pending || PRIORITY[c] >= PRIORITY[pending]) pending = c;
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(() => {
    flushQueued = false;
    const p = pending;
    pending = null;
    if (p) play(p);
  });
}

/** For the startup sound: waits for the pack, but never plays late. */
export async function cueWhenReady(c: Cue, maxWaitMs = 700) {
  const t = performance.now();
  await loaded;
  if (performance.now() - t <= maxWaitMs) play(c);
}

function play(c: Cue) {
  const buf = buffers.get(c);
  if (!buf || !ctx) return;
  const now = performance.now();
  // Holding a direction repeats ~20×/s: keep it crisp, not a smear.
  const minGap = c === "move" || c === "type" ? 32 : 60;
  if (now - (lastPlayed.get(c) ?? 0) < minGap) return;
  lastPlayed.set(c, now);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(master);
  src.start();
  voices.push(src);
  src.onended = () => voices.splice(voices.indexOf(src), 1);
  while (voices.length > 6) voices.shift()?.stop();
}

// ---- built-in pack: synthesized once into buffers ------------------------------------

const SR = 44100;

async function render(seconds: number, build: (ac: OfflineAudioContext, out: AudioNode) => void): Promise<AudioBuffer> {
  const ac = new OfflineAudioContext(1, Math.ceil(seconds * SR), SR);
  const out = ac.createDynamicsCompressor();
  out.connect(ac.destination);
  build(ac, out);
  return ac.startRendering();
}

/** A pitched blip with a fast attack and exponential decay. */
function tone(ac: BaseAudioContext, out: AudioNode, o: { f: number; f2?: number; at?: number; dur: number; gain: number; type?: OscillatorType }) {
  const t = o.at ?? 0;
  const osc = ac.createOscillator();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(o.f, t);
  if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + o.dur * 0.8);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + o.dur + 0.02);
}

/** Filtered noise sweep: whooshes for menus and tabs. */
function whoosh(ac: BaseAudioContext, out: AudioNode, o: { from: number; to: number; dur: number; gain: number; at?: number }) {
  const t = o.at ?? 0;
  const len = Math.ceil((o.dur + 0.05) * SR);
  const buf = ac.createBuffer(1, len, SR);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 1.4;
  bp.frequency.setValueAtTime(o.from, t);
  bp.frequency.exponentialRampToValueAtTime(o.to, t + o.dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.gain, t + o.dur * 0.35);
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  src.connect(bp).connect(g).connect(out);
  src.start(t);
}

const SYNTH: Record<Cue, () => Promise<AudioBuffer>> = {
  move: () => render(0.08, (ac, o) => {
    tone(ac, o, { f: 1900, f2: 1700, dur: 0.05, gain: 0.16 });
    tone(ac, o, { f: 3800, dur: 0.025, gain: 0.03 });
  }),
  bump: () => render(0.16, (ac, o) => {
    tone(ac, o, { f: 150, f2: 90, dur: 0.12, gain: 0.4 });
    tone(ac, o, { f: 600, dur: 0.03, gain: 0.05, type: "triangle" });
  }),
  select: () => render(0.16, (ac, o) => {
    tone(ac, o, { f: 880, dur: 0.07, gain: 0.22 });
    tone(ac, o, { f: 1320, at: 0.045, dur: 0.09, gain: 0.2 });
  }),
  type: () => render(0.04, (ac, o) => tone(ac, o, { f: 2600, dur: 0.02, gain: 0.1, type: "triangle" })),
  sliderUp: () => render(0.06, (ac, o) => tone(ac, o, { f: 1500, dur: 0.035, gain: 0.16 })),
  sliderDown: () => render(0.06, (ac, o) => tone(ac, o, { f: 1150, dur: 0.035, gain: 0.16 })),
  volume: () => render(0.07, (ac, o) => tone(ac, o, { f: 1250, dur: 0.045, gain: 0.18 })),
  toggleOn: () => render(0.14, (ac, o) => {
    tone(ac, o, { f: 1000, dur: 0.05, gain: 0.18 });
    tone(ac, o, { f: 1500, at: 0.05, dur: 0.07, gain: 0.18 });
  }),
  toggleOff: () => render(0.14, (ac, o) => {
    tone(ac, o, { f: 1500, dur: 0.05, gain: 0.16 });
    tone(ac, o, { f: 1000, at: 0.05, dur: 0.07, gain: 0.16 });
  }),
  toast: () => render(0.6, (ac, o) => {
    tone(ac, o, { f: 1046, dur: 0.45, gain: 0.14 });
    tone(ac, o, { f: 1318, at: 0.09, dur: 0.45, gain: 0.12 });
  }),
  tab: () => render(0.2, (ac, o) => {
    whoosh(ac, o, { from: 700, to: 3200, dur: 0.14, gain: 0.22 });
    tone(ac, o, { f: 1700, at: 0.02, dur: 0.05, gain: 0.08 });
  }),
  railIn: () => render(0.28, (ac, o) => whoosh(ac, o, { from: 400, to: 2400, dur: 0.22, gain: 0.25 })),
  railOut: () => render(0.28, (ac, o) => whoosh(ac, o, { from: 2400, to: 400, dur: 0.22, gain: 0.22 })),
  modalOpen: () => render(0.3, (ac, o) => {
    tone(ac, o, { f: 600, f2: 950, dur: 0.18, gain: 0.16, type: "triangle" });
    tone(ac, o, { f: 1900, at: 0.08, dur: 0.18, gain: 0.05 });
  }),
  modalClose: () => render(0.3, (ac, o) => tone(ac, o, { f: 950, f2: 560, dur: 0.18, gain: 0.15, type: "triangle" })),
  open: () => render(0.35, (ac, o) => {
    tone(ac, o, { f: 520, f2: 1040, dur: 0.22, gain: 0.16, type: "triangle" });
    whoosh(ac, o, { from: 900, to: 4000, dur: 0.22, gain: 0.08 });
  }),
  back: () => render(0.3, (ac, o) => {
    tone(ac, o, { f: 1040, f2: 520, dur: 0.2, gain: 0.15, type: "triangle" });
    whoosh(ac, o, { from: 3500, to: 800, dur: 0.18, gain: 0.06 });
  }),
  launch: () => render(1.0, (ac, o) => {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(ac, o, { f, at: i * 0.035, dur: 0.75, gain: 0.11 }));
    whoosh(ac, o, { from: 500, to: 5000, dur: 0.4, gain: 0.12 });
  }),
  success: () => render(0.8, (ac, o) => {
    [783.99, 987.77, 1174.66].forEach((f, i) => tone(ac, o, { f, at: i * 0.08, dur: 0.5, gain: 0.14 }));
  }),
  error: () => render(0.4, (ac, o) => {
    tone(ac, o, { f: 330, dur: 0.14, gain: 0.2, type: "triangle" });
    tone(ac, o, { f: 247, at: 0.13, dur: 0.22, gain: 0.2, type: "triangle" });
  }),
  startup: () => render(2.8, (ac, o) => {
    // Soft Cmaj9 pad blooming with the logo, plus a rising shimmer.
    [261.63, 329.63, 392, 493.88, 587.33].forEach((f, i) => {
      const t = i * 0.06;
      const osc = ac.createOscillator();
      osc.type = i % 2 ? "triangle" : "sine";
      osc.frequency.value = f;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.09, t + 0.35);
      g.gain.exponentialRampToValueAtTime(0.0001, 2.7);
      osc.connect(g).connect(o);
      osc.start(t);
      osc.stop(2.75);
    });
    whoosh(ac, o, { from: 600, to: 6000, at: 0.7, dur: 0.9, gain: 0.07 });
    tone(ac, o, { f: 1567.98, at: 0.85, dur: 1.2, gain: 0.05 });
  }),
};
