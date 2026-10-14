import { openKV, type KV } from "./platform";

export interface Settings {
  clientId: string;
  clientSecret: string;
  region: string;
  startFullscreen: boolean;
  reducedMotion: boolean;
  uiScale: number;
  autoplayNext: boolean;
  /** What plays at launch: the Panorama startup movie, the user's own video, or nothing. */
  startup: "default" | "video" | "off";
  /** Imported copy of the user's startup video (in app data). */
  startupVideo: string;
  startupVideoVersion: number;
  uiSounds: "steam" | "panorama" | "off";
  uiVolume: number;
  searchHistory: string[];
  /** Quota units spent, keyed by the Pacific-time day the API resets on. */
  quota: { day: string; units: number };
}

// `.env.local` values are a development convenience only. Each `import.meta.env.X`
// sits behind a literal DEV check so Vite strips it from release builds: the
// installer never contains the developer's credentials. Users bring their own
// via Settings → Sign-in setup.
const dev = (v: string | undefined) => (import.meta.env.DEV ? (v ?? "") : "");
const defaults: Settings = {
  clientId: "",
  clientSecret: "",
  region: guessRegion(),
  startFullscreen: false,
  reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  uiScale: 1,
  autoplayNext: true,
  startup: "default",
  startupVideo: "",
  startupVideoVersion: 0,
  uiSounds: "steam",
  uiVolume: 0.7,
  searchHistory: [],
  quota: { day: "", units: 0 },
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
  delete saved.apiKey;
  current = { ...defaults, ...(saved as Partial<Settings>) };
  return current;
}

export function settings(): Readonly<Settings> {
  return current;
}

export function effectiveOAuth(): { clientId: string; clientSecret: string } {
  if (current.clientId) return { clientId: current.clientId, clientSecret: current.clientSecret };
  if (!import.meta.env.DEV) return { clientId: "", clientSecret: "" };
  return { clientId: dev(import.meta.env.VITE_GOOGLE_CLIENT_ID), clientSecret: dev(import.meta.env.VITE_GOOGLE_CLIENT_SECRET) };
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

/** The Data API quota resets at midnight Pacific time. */
export function quotaDay(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}

export function addQuota(units: number): void {
  const day = quotaDay();
  const used = current.quota.day === day ? current.quota.units : 0;
  updateSettings({ quota: { day, units: used + units } });
}
