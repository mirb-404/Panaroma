// Shown while Google's sign-in window is open.
import { h } from "../dom";
import { router } from "../router";

export function openSignInWait(onCancel: () => void): { close(): void } {
  let closed = false;
  const cancel = h("button.btn.focused", { onclick: () => router.closeOverlay() }, "Cancel");
  const el = h(
    "div.overlay.signin-wait",
    null,
    h(
      "div.dialog-panel",
      null,
      h("div.wait-spinner"),
      h("h2", null, "Sign in to YouTube"),
      h("p", null, "Use the Google sign-in window to sign in with your account. Panorama continues automatically when you're done."),
      h("div.btn-row", null, cancel),
    ),
  );
  router.openOverlay({
    el,
    onClose: () => {
      if (closed) return;
      closed = true;
      onCancel();
    },
    onAction(e) {
      if (e.action === "select") {
        cancel.click();
        return true;
      }
      return false;
    },
  });
  return {
    close() {
      if (closed) return;
      closed = true;
      router.closeOverlay();
    },
  };
}
