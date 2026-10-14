import { openKV, type KV } from "./platform";

export interface Settings {
  /** Country for YouTube results (the `gl` parameter). */
  region: string;
  startFullscreen: boolean;
  reducedMotion: boolean;
  uiScale: number;
  autoplayNext: boolean;
  /** Zoom 16:9 video to fill ultrawide screens (theater layout). */
  ultrawideFill: boolean;
  /** What plays at launch: the Panorama startup movie, the user's own video, or nothing. */
  startup: "default" | "video" | "off";
  /** Imported copy of the user's startup video (in app data). */
  startupVideo: string;
  startupVideoVersion: number;
  uiSounds: "steam" | "panorama" | "off";
  uiVolume: number;
  searchHistory: string[];
  /** The signed-in account's picture and name, cached for instant display. */
  avatarUrl: string;
  accountName: string;
  /** Bumped when a default changes and saved settings need a one-time update. */
  version: number;
}

const defaults: Settings = {
  region: guessRegion(),
  startFullscreen: true,
  reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  uiScale: 1,
  autoplayNext: true,
  ultrawideFill: true,
  startup: "default",
  startupVideo: "",
  startupVideoVersion: 0,
  uiSounds: "panorama",
  uiVolume: 0.7,
  searchHistory: [],
  avatarUrl: "",
  accountName: "",
  version: 3,
};

function guessRegion(): string {
  const tag = navigator.language.split("-")[1];
  return tag && tag.length === 2 ? tag.toUpperCase() : "US";
}

let kv: KV;
let current: Settings = { ...defaults };
const listeners = new Set<(s: Settings) => void>();

export async function loadSettings(): Promise<Settings> {
  kv = await openKV("settings.json");
  const saved = (await kv.get<Record<string, unknown>>("settings")) ?? {};
  // Migrations from earlier versions.
  if (saved.introAnimation === false && saved.startup === undefined) saved.startup = "off";
  if (saved.startup === "ident") saved.startup = "default";
  delete saved.introAnimation;
  // Leftovers from the Data API / OAuth era.
  for (const k of ["apiKey", "clientId", "clientSecret", "quota"]) delete saved[k];
  // One-time updates when a default changes.
  const v = (saved.version as number) ?? 1;
  if (v < 2) saved.startFullscreen = true; // v2: fullscreen by default
  if (v < 3 && saved.uiSounds === "steam") saved.uiSounds = "panorama"; // v3: Panorama sounds by default
  saved.version = 3;
  current = { ...defaults, ...(saved as Partial<Settings>) };
  return current;
}

export function settings(): Readonly<Settings> {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  kv?.set("settings", current);
  listeners.forEach((l) => l(current));
}

export function onSettings(l: (s: Settings) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
