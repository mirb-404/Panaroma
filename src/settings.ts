import { openKV, type KV } from "./platform";

export interface Settings {
  apiKey: string;
  clientId: string;
  clientSecret: string;
  region: string;
  startFullscreen: boolean;
  reducedMotion: boolean;
  uiScale: number;
  autoplayNext: boolean;
  introAnimation: boolean;
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
  apiKey: "",
  clientId: "",
  clientSecret: "",
  region: guessRegion(),
  startFullscreen: false,
  reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  uiScale: 1,
  autoplayNext: true,
  introAnimation: true,
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
  const saved = (await kv.get<Partial<Settings>>("settings")) ?? {};
  current = { ...defaults, ...saved };
  return current;
}

export function settings(): Readonly<Settings> {
  return current;
}

export function effectiveApiKey(): string {
  return current.apiKey || (import.meta.env.DEV ? dev(import.meta.env.VITE_YT_API_KEY) : "");
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
