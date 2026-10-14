// Thin bridge over Tauri so the UI also runs in a plain browser (`pnpm dev`)
// for quick iteration; native-only features degrade to no-ops there.
import type { UnlistenFn } from "@tauri-apps/api/event";

export const isTauri = "__TAURI_INTERNALS__" in window;

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) throw new Error(`"${cmd}" needs the desktop app`);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export async function listen<T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => cb(e.payload));
}

export async function openExternal(url: string): Promise<void> {
  if (!isTauri) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

export async function setFullscreen(on: boolean): Promise<boolean> {
  if (!isTauri) {
    if (on) await document.documentElement.requestFullscreen().catch(() => {});
    else if (document.fullscreenElement) await document.exitFullscreen();
    return !!document.fullscreenElement;
  }
  return invoke<boolean>("set_fullscreen", { on });
}

export async function isFullscreen(): Promise<boolean> {
  return isTauri ? invoke<boolean>("is_fullscreen") : !!document.fullscreenElement;
}

export function appReady(): void {
  if (isTauri) invoke("app_ready").catch(() => {});
}

export function quitApp(): void {
  if (isTauri) invoke("quit_app").catch(() => {});
}

/** Key/value persistence: the Tauri store plugin on desktop, localStorage in a browser. */
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export async function openKV(file: string): Promise<KV> {
  if (isTauri) {
    const { load } = await import("@tauri-apps/plugin-store");
    const store = await load(file, { autoSave: 250, defaults: {} });
    return {
      get: (k) => store.get(k),
      set: (k, v) => store.set(k, v),
    };
  }
  const prefix = `${file}:`;
  return {
    async get<T>(k: string) {
      try {
        const raw = localStorage.getItem(prefix + k);
        return raw == null ? undefined : (JSON.parse(raw) as T);
      } catch {
        return undefined;
      }
    },
    async set(k, v) {
      try {
        localStorage.setItem(prefix + k, JSON.stringify(v));
      } catch {
        /* storage unavailable: settings last for this session only */
      }
    },
  };
}
