import { ApiError } from "../api";
import { oauthConfigured, signIn } from "../auth";
import { messagePanel, router } from "../router";
import { toast } from "../ui/chrome";
import { openOAuthSetup } from "../ui/oauthsetup";

/** Maps a load failure to a helpful full-screen message with a next step. */
export function errorPanel(err: unknown) {
  const reason = err instanceof ApiError ? err.reason : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (reason === "noKey")
    return messagePanel(
      "Connect to YouTube",
      "Panorama uses the official YouTube Data API. Add an API key in Settings to start browsing.",
      [{ label: "Open Settings", run: () => router.showTab("settings") }],
    );
  if (reason === "signedOut")
    return oauthConfigured()
      ? messagePanel("Welcome to Panorama", "Sign in with your Google account to watch YouTube — your subscriptions, likes and playlists come along.", [
          { label: "Sign in with Google", run: () => signInFlow() },
        ])
      : messagePanel(
          "Welcome to Panorama",
          "Connect your Google account to start watching. First-time setup takes about 3 minutes: you create a free Google Cloud sign-in client and paste it into Panorama. The guide walks you through it.",
          [{ label: "Set up sign-in", run: () => openOAuthSetup() }],
        );
  if (reason === "empty") return messagePanel("Nothing here yet", "", []);
  return messagePanel("Couldn't load this", msg, [{ label: "Retry", run: () => router.resetTab(router.tab) }]);
}

export async function signInFlow() {
  toast("Finish signing in in your browser…");
  try {
    await signIn();
    toast("Signed in"); // the onAuth listener in main.ts rebuilds the tabs
  } catch (e) {
    toast(`Sign-in failed: ${e}`, "error", 5000);
  }
}
