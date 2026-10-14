import { ApiError } from "../api";
import { canSignIn, cancelSignIn, signIn } from "../auth";
import { messagePanel, router } from "../router";
import { toast } from "../ui/chrome";
import { openSignInWait } from "../ui/signin";

/** Maps a load failure to a helpful full-screen message with a next step. */
export function errorPanel(err: unknown) {
  const reason = err instanceof ApiError ? err.reason : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (reason === "signedOut")
    return canSignIn()
      ? messagePanel("Welcome to Panorama", "Sign in with your Google account to watch YouTube — your recommendations, subscriptions, history and playlists come along.", [
          { label: "Sign in with Google", run: () => signInFlow() },
        ])
      : messagePanel("Welcome to Panorama", "Signing in needs the Panorama desktop app.", []);
  if (reason === "empty") return messagePanel("Nothing here yet", "", []);
  return messagePanel("Couldn't load this", msg, [{ label: "Retry", run: () => router.resetTab(router.tab) }]);
}

let signingIn = false;

export async function signInFlow() {
  if (signingIn) return;
  signingIn = true;
  const wait = openSignInWait(cancelSignIn);
  try {
    await signIn();
    wait.close();
    toast("Signed in", "success"); // the onAuth listener in main.ts rebuilds the tabs
  } catch (e) {
    wait.close();
    if (String(e) === "cancelled") toast("Sign-in cancelled");
    else toast(`Sign-in failed: ${e}`, "error", 6000);
  } finally {
    signingIn = false;
  }
}
