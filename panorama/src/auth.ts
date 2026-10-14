import { invoke, isTauri } from "./platform";
import { effectiveOAuth } from "./settings";

interface Session {
  access_token: string;
  expires_at: number;
}

let session: Session | null = null;
let refreshing: Promise<string | null> | null = null;
const listeners = new Set<(signedIn: boolean) => void>();

export function onAuth(l: (signedIn: boolean) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function set(s: Session | null) {
  const changed = !!s !== !!session;
  session = s;
  if (changed) listeners.forEach((l) => l(!!s));
}

export const signedIn = () => !!session;
export const oauthConfigured = () => isTauri && !!effectiveOAuth().clientId;

/** Restores a previous sign-in from the stored refresh token, if any. */
export async function restoreSession(): Promise<void> {
  if (!oauthConfigured()) return;
  await accessToken().catch(() => null);
}

/** Set once we know there is no stored sign-in, so signed-out browsing doesn't
 *  ask the Rust side on every request. */
let knownSignedOut = false;

/** A valid access token, refreshed through the Rust side when it has expired. */
export async function accessToken(): Promise<string | null> {
  if (session && session.expires_at > Date.now()) return session.access_token;
  if (!oauthConfigured() || (knownSignedOut && !session)) return null;
  refreshing ??= invoke<Session | null>("oauth_refresh", effectiveOAuth())
    .then((s) => {
      set(s);
      knownSignedOut = !s;
      return s?.access_token ?? null;
    })
    .finally(() => (refreshing = null));
  return refreshing;
}

export async function signIn(): Promise<void> {
  set(await invoke<Session>("oauth_sign_in", effectiveOAuth()));
  knownSignedOut = false;
}

export async function signOut(): Promise<void> {
  await invoke("oauth_sign_out");
  knownSignedOut = true;
  set(null);
}
