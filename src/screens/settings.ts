import { onAuth, oauthConfigured, signedIn, signOut } from "../auth";
import { cacheClear } from "../cache";
import { h, icon } from "../dom";
import type { ActionEvent } from "../input";
import { isTauri, openExternal, quitApp, setFullscreen } from "../platform";
import { edgeBump, router, TABS, type Screen } from "../router";
import { effectiveApiKey, onSettings, quotaDay, settings, updateSettings } from "../settings";
import { applyScale, setBackdrop, toast } from "../ui/chrome";
import { CREDENTIALS_URL, openOAuthSetup, YT_API_URL } from "../ui/oauthsetup";
import { confirmDialog, openTextEntry } from "../ui/textentry";
import { signInFlow } from "./common";

interface Row {
  label: string;
  value?: () => string;
  help: string;
  select?: () => void;
  /** Left/right adjustment for cycling values. */
  adjust?: (dir: -1 | 1) => void;
  section?: string;
  /** Clickable links shown in the help panel. */
  links?: { label: string; url: string }[];
}

const REGIONS = ["US", "GB", "CA", "AU", "IN", "DE", "FR", "ES", "IT", "NL", "SE", "JP", "KR", "BR", "MX", "IE", "NZ", "ZA", "SG", "PH"];
const SCALES = [0.8, 0.9, 1, 1.1, 1.2, 1.35];

const mask = (s: string) => (!s ? "Not set" : s.length <= 10 ? "••••••" : `${s.slice(0, 6)}…${s.slice(-4)}`);
const onOff = (b: boolean) => (b ? "On" : "Off");

function cycle<T>(list: T[], cur: T, dir: number): T {
  const i = list.indexOf(cur);
  return list[(i + dir + list.length) % list.length] ?? list[0];
}

/** Rebuild content tabs (keys/region changed), leaving this screen in place. */
function refreshContent() {
  for (const t of TABS) if (t !== "settings") router.resetTab(t);
}

export function settingsScreen(): Screen {
  let idx = 0;
  const rows: Row[] = [
    {
      section: "Account",
      label: "Sign-in setup",
      value: () => (oauthConfigured() ? "Ready" : "Not set up — select to start"),
      help: "Panorama doesn't ship with Google credentials — you create your own free OAuth client in about 3 minutes: enable the YouTube Data API v3, then Credentials → Create credentials → OAuth client ID → Desktop app → Create, and paste the Client ID and Client secret here. Select this row for a step-by-step guide.",
      links: [
        { label: "Open YouTube Data API v3 page", url: YT_API_URL },
        { label: "Open Credentials page", url: CREDENTIALS_URL },
      ],
      select: () => openOAuthSetup(),
    },
    {
      label: "OAuth Client ID",
      value: () => (settings().clientId ? mask(settings().clientId) : "Not set"),
      help: "From Google Cloud Console → Credentials → your Desktop app OAuth client. It ends with .apps.googleusercontent.com. Paste it here (Ctrl+V or the Paste key).",
      links: [{ label: "Open Credentials page", url: CREDENTIALS_URL }],
      select: () =>
        openTextEntry({
          title: "OAuth Client ID",
          hint: "Paste your Client ID (ends with .apps.googleusercontent.com)",
          value: settings().clientId,
          onSubmit: (v) => updateSettings({ clientId: v.replace(/\s+/g, "") }),
        }),
    },
    {
      label: "OAuth Client secret",
      value: () => mask(settings().clientSecret),
      help: "Shown next to the Client ID in Google Cloud Console (usually starts with GOCSPX-). Desktop-app secrets aren't treated as confidential by Google; sign-in also uses PKCE, and your sign-in is stored in Windows Credential Manager.",
      links: [{ label: "Open Credentials page", url: CREDENTIALS_URL }],
      select: () =>
        openTextEntry({
          title: "OAuth Client secret",
          hint: "Paste your Client secret (usually starts with GOCSPX-)",
          value: settings().clientSecret,
          secret: true,
          onSubmit: (v) => updateSettings({ clientSecret: v.replace(/\s+/g, "") }),
        }),
    },
    {
      label: "Google account",
      value: () => (signedIn() ? "Signed in — select to sign out" : oauthConfigured() ? "Select to sign in" : isTauri ? "Finish sign-in setup first" : "Desktop app only"),
      help: "Signing in opens your browser for Google's consent screen; Panorama only requests read-only access to your YouTube account.",
      select: () => {
        if (signedIn())
          confirmDialog("Sign out?", "Your subscriptions and library will be hidden until you sign in again.", "Sign out", async () => {
            await signOut().catch(() => {});
            toast("Signed out");
          });
        else if (oauthConfigured()) signInFlow();
        else openOAuthSetup();
      },
    },
    {
      section: "Display",
      label: "Region",
      value: () => settings().region,
      help: "Country used for Trending and category shelves. Use ◀ ▶ to change.",
      adjust: (d) => {
        updateSettings({ region: cycle(REGIONS, settings().region, d) });
        refreshContent();
      },
    },
    {
      label: "Interface size",
      value: () => `${Math.round(settings().uiScale * 100)}%`,
      help: "Scales the entire interface. Use ◀ ▶ to change — larger is easier to read from the couch.",
      adjust: (d) => {
        const i = Math.max(0, Math.min(SCALES.length - 1, SCALES.indexOf(settings().uiScale) + d));
        updateSettings({ uiScale: SCALES[i] ?? 1 });
        applyScale();
      },
    },
    {
      label: "Start in fullscreen",
      value: () => onOff(settings().startFullscreen),
      help: "Launch straight into fullscreen. Toggle fullscreen anytime with F11 or by clicking the right stick.",
      select: () => {
        updateSettings({ startFullscreen: !settings().startFullscreen });
        setFullscreen(settings().startFullscreen);
      },
    },
    {
      label: "Motion",
      value: () => (settings().reducedMotion ? "Reduced" : "Full"),
      help: "Reduced motion replaces slides and springs with instant changes.",
      select: () => {
        updateSettings({ reducedMotion: !settings().reducedMotion });
        applyScale();
      },
    },
    {
      label: "Startup animation",
      value: () => onOff(settings().introAnimation),
      help: "Play the Panorama ident when the app opens. Any button skips it.",
      select: () => updateSettings({ introAnimation: !settings().introAnimation }),
    },
    {
      label: "Autoplay next video",
      value: () => onOff(settings().autoplayNext),
      help: "When a video ends, play the next one from the row you started in after a short countdown.",
      select: () => updateSettings({ autoplayNext: !settings().autoplayNext }),
    },
    {
      section: "Data",
      label: "API quota used today",
      value: () => `${settings().quota.day === quotaDay() ? settings().quota.units : 0} / 10,000 units`,
      help: "Estimated from this device. Browsing costs 1 unit per request; each search costs 100. The quota resets at midnight Pacific time.",
    },
    {
      label: "Clear cache",
      help: "Forget cached YouTube responses and fetch everything fresh.",
      select: async () => {
        await cacheClear();
        refreshContent();
        toast("Cache cleared");
      },
    },
    {
      label: "Clear search history",
      help: "Remove your recent searches from this device.",
      select: () => {
        updateSettings({ searchHistory: [] });
        router.resetTab("search");
        toast("Search history cleared");
      },
    },
    {
      section: "Advanced",
      label: "YouTube API key (optional)",
      value: () => (settings().apiKey ? mask(settings().apiKey) : effectiveApiKey() ? "From .env.local (dev)" : "Not set"),
      help: "Not needed when you're signed in. Only lets Trending and search work while signed out. Create one in Google Cloud Console for the YouTube Data API v3 and paste it here (Ctrl+V works).",
      select: () =>
        openTextEntry({
          title: "YouTube API key",
          hint: "Paste your YouTube Data API v3 key",
          value: settings().apiKey,
          secret: true,
          onSubmit: (v) => {
            updateSettings({ apiKey: v });
            refreshContent();
            toast(v ? "API key saved" : "API key cleared");
          },
        }),
    },
    {
      section: "About",
      label: "YouTube Terms of Service",
      help: "By using Panorama you agree to be bound by the YouTube Terms of Service.",
      select: () => openExternal("https://www.youtube.com/t/terms"),
    },
    {
      label: "Google Privacy Policy",
      help: "Panorama uses YouTube API Services; Google's Privacy Policy applies.",
      select: () => openExternal("https://policies.google.com/privacy"),
    },
    {
      label: "Manage Google account access",
      help: "Revoke Panorama's access to your Google account at any time from Google's security settings.",
      select: () => openExternal("https://myaccount.google.com/permissions"),
    },
    {
      label: "Quit Panorama",
      help: "Close the app.",
      select: () => quitApp(),
    },
  ];

  const list = h("div.settings-list");
  const help = h("aside.settings-help");
  const els = rows.map((r) => {
    const val = h("span.s-value");
    const row = h(
      `div.s-row${r.select || r.adjust ? "" : ".static"}`,
      {
        onclick: () => {
          idx = els.indexOf(row);
          r.select?.();
          sync();
        },
      },
      h("span.s-label", null, r.label),
      val,
    );
    if (r.section) list.append(h("h3.s-section", null, r.section));
    list.append(row);
    return row;
  });

  function sync() {
    els.forEach((e, i) => {
      e.classList.toggle("focused", i === idx);
      const v = rows[i].value?.();
      const valEl = e.querySelector(".s-value")!;
      valEl.textContent = v ? (rows[i].adjust ? `◀  ${v}  ▶` : v) : "";
    });
    help.replaceChildren(
      h("h2", null, rows[idx].label),
      h("p", null, rows[idx].help),
      ...(rows[idx].links ?? []).map((l) =>
        h("button.help-link", { onclick: () => openExternal(l.url), title: l.url }, icon("external"), h("span", null, l.label)),
      ),
    );
    const target = els[idx];
    const top = target.offsetTop - list.clientHeight * 0.4;
    list.scrollTo({ top, behavior: settings().reducedMotion ? "auto" : "smooth" });
  }

  // Values change asynchronously (text entry, sign-in), so re-render on any change.
  onSettings(() => !el.hidden && sync());
  onAuth(() => !el.hidden && sync());

  const el = h("section.screen.settings-screen", null, h("h1.page-title", null, "Settings"), h("div.settings-body", null, list, help));

  return {
    el,
    onShow() {
      setBackdrop(null);
      sync();
    },
    onAction(e: ActionEvent) {
      const r = rows[idx];
      switch (e.action) {
        case "up":
          if (idx === 0) return e.repeat || (edgeBump(), true);
          idx--;
          break;
        case "down":
          if (idx === rows.length - 1) return e.repeat || (edgeBump(), true);
          idx++;
          break;
        case "left":
          if (!r.adjust) return false;
          r.adjust(-1);
          break;
        case "right":
          if (!r.adjust) return e.repeat || (edgeBump(), true);
          r.adjust(1);
          break;
        case "select":
          r.select?.();
          break;
        default:
          return false;
      }
      sync();
      return true;
    },
  };
}
