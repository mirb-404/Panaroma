// Sign-in state is the youtube.com session in the app's browser profile. Signing
// in opens Google's own login page in a separate window (handled in Rust); there
// is no API key or OAuth client to configure.
import { invoke, isTauri, listen } from "./platform";

let signed = false;
const listeners = new Set<(signedIn: boolean) => void>();

export function onAuth(l: (signedIn: boolean) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function set(v: boolean) {
  if (v === signed) return;
  signed = v;
  listeners.forEach((l) => l(v));
}

export const signedIn = () => signed;
/** Signing in needs the desktop app (the browser-only dev build can't). */
export const canSignIn = () => isTauri;

const isDemo = () => import.meta.env.DEV && new URLSearchParams(location.search).has("demo");

export async function restoreSession(): Promise<void> {
  if (isDemo()) return set(true);
  if (!isTauri) return;
  set(await invoke<boolean>("yt_signed_in").catch(() => false));
}

/** Opens Google's sign-in window; resolves once signed in, rejects "cancelled" if closed. */
export function signIn(): Promise<void> {
  return new Promise((resolve, reject) => {
    const off: (() => void)[] = [];
    const done = (fn: () => void) => {
      off.forEach((f) => f());
      fn();
    };
    listen<boolean>("yt-auth", () =>
      done(() => {
        set(true);
        resolve();
      }),
    ).then((f) => off.push(f));
    listen("yt-signin-closed", () => done(() => (signed ? resolve() : reject("cancelled")))).then((f) => off.push(f));
    invoke("yt_open_sign_in").catch((e) => done(() => reject(String(e))));
  });
}

export function cancelSignIn() {
  invoke("yt_close_sign_in").catch(() => {});
}

export async function signOut(): Promise<void> {
  await invoke("yt_sign_out");
  set(false);
}
