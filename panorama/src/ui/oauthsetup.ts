// Guided "bring your own Google credentials" setup. Panorama ships without a
// client ID, so each user creates a free Desktop OAuth client in their own
// Google Cloud project and pastes it here.
import { signedIn } from "../auth";
import { h, icon } from "../dom";
import type { ActionEvent } from "../input";
import { openExternal } from "../platform";
import { router } from "../router";
import { signInFlow } from "../screens/common";
import { settings, updateSettings } from "../settings";
import { toast } from "./chrome";
import { openTextEntry } from "./textentry";

/** Neutral links: they open in whichever project the user has selected. */
export const YT_API_URL = "https://console.cloud.google.com/apis/library/youtube.googleapis.com";
export const CREDENTIALS_URL = "https://console.cloud.google.com/apis/credentials";

const ID_SUFFIX = ".apps.googleusercontent.com";

const mask = (s: string) => (s.length <= 12 ? s : `${s.slice(0, 8)}…${s.slice(-6)}`);

export function openOAuthSetup() {
  let idx = 0;

  const steps = h(
    "ol.setup-steps",
    null,
    h("li", null, "Open the ", h("b", null, "YouTube Data API v3"), " page below and click ", h("b", null, "Enable"),
      h("span.setup-note", null, "Sign in to Google Cloud and create a project if it asks. It's free.")),
    h("li", null, "Open ", h("b", null, "Credentials"), " → ", h("b", null, "Create credentials"), " → ", h("b", null, "OAuth client ID"), ".",
      h("span.setup-note", null, "If Google asks you to configure the consent screen first, choose External, enter an app name and your email, and add your Gmail under Test users.")),
    h("li", null, "Application type: ", h("b", null, "Desktop app"), " → ", h("b", null, "Create"), "."),
    h("li", null, "Copy the ", h("b", null, "Client ID"), " and ", h("b", null, "Client secret"), " and paste them below."),
  );

  const linkApi = h("button.setup-btn.link", { onclick: () => openExternal(YT_API_URL) }, icon("external"), h("span", null, "Open YouTube Data API v3 page"));
  const linkCreds = h("button.setup-btn.link", { onclick: () => openExternal(CREDENTIALS_URL) }, icon("external"), h("span", null, "Open Credentials page"));
  const idBtn = h("button.setup-btn.field", { onclick: () => editId() });
  const secretBtn = h("button.setup-btn.field", { onclick: () => editSecret() });
  const signInBtn = h("button.setup-btn.primary", { onclick: () => signIn() }, "Sign in with Google");
  const buttons = [linkApi, linkCreds, idBtn, secretBtn, signInBtn];

  const el = h(
    "div.overlay.oauth-setup",
    null,
    h(
      "div.setup-panel",
      null,
      h("h2", null, "Set up Google sign-in"),
      h("p.setup-intro", null, "Panorama connects to YouTube with your own free Google credentials. This takes about 3 minutes and only needs to be done once."),
      steps,
      h("div.setup-actions", null, h("div.setup-links", null, linkApi, linkCreds), idBtn, secretBtn, signInBtn),
      h("p.te-legend", null, "Ⓐ select   Ⓑ close   ·   the links open in your browser"),
    ),
  );

  function render() {
    const { clientId, clientSecret } = settings();
    idBtn.replaceChildren(h("span.setup-label", null, "Client ID"), h("span.setup-value", null, clientId ? mask(clientId) : "Paste here"));
    secretBtn.replaceChildren(
      h("span.setup-label", null, "Client secret"),
      h("span.setup-value", null, clientSecret ? "•".repeat(10) + clientSecret.slice(-4) : "Paste here"),
    );
    idBtn.classList.toggle("filled", !!clientId);
    secretBtn.classList.toggle("filled", !!clientSecret);
    const ready = !!clientId && !!clientSecret;
    signInBtn.classList.toggle("disabled", !ready);
    signInBtn.textContent = signedIn() ? "Signed in ✓" : "Sign in with Google";
    buttons.forEach((b, i) => b.classList.toggle("focused", i === idx));
  }

  function editId() {
    openTextEntry({
      title: "Client ID",
      hint: `Paste the Client ID (ends with ${ID_SUFFIX})`,
      value: settings().clientId,
      onSubmit: (v) => {
        v = v.replace(/\s+/g, "");
        if (v && !v.endsWith(ID_SUFFIX)) toast(`That doesn't look like a Client ID — it should end with ${ID_SUFFIX}`, "error", 5000);
        updateSettings({ clientId: v });
        if (v) idx = 3;
        render();
      },
    });
  }

  function editSecret() {
    openTextEntry({
      title: "Client secret",
      hint: "Paste the Client secret (usually starts with GOCSPX-)",
      value: settings().clientSecret,
      secret: true,
      onSubmit: (v) => {
        v = v.replace(/\s+/g, "");
        if (v && !v.startsWith("GOCSPX-")) toast("That doesn't look like a Client secret — it usually starts with GOCSPX-", "error", 5000);
        updateSettings({ clientSecret: v });
        if (v) idx = 4;
        render();
      },
    });
  }

  function signIn() {
    if (!settings().clientId || !settings().clientSecret) {
      toast("Paste your Client ID and Client secret first", "error");
      return;
    }
    if (signedIn()) return;
    router.closeOverlay();
    signInFlow();
  }

  render();
  router.openOverlay({
    el,
    onAction(e: ActionEvent) {
      // Two link buttons sit side by side; everything else is a vertical list.
      if (e.action === "left" && idx === 1) idx = 0;
      else if (e.action === "right" && idx === 0) idx = 1;
      else if (e.action === "up") idx = idx <= 1 ? idx : idx === 2 ? 0 : idx - 1;
      else if (e.action === "down") idx = idx <= 1 ? 2 : Math.min(buttons.length - 1, idx + 1);
      else if (e.action === "select") {
        buttons[idx].click();
        return true;
      } else return false;
      render();
      return true;
    },
  });
}
