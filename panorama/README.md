# Panorama

A lean-back, controller-first YouTube client for Windows, designed for ultrawide
displays. Built on **Tauri v2** (Rust + WebView2) with a framework-free
TypeScript UI. Content comes from the official **YouTube Data API v3**, and playback
uses the official **YouTube IFrame Player**.

## Install

Run `src-tauri/target/release/bundle/msi/Panorama_<version>_x64_en-US.msi`.
The installer bundles the WebView2 bootstrapper, so it also works on machines that
don't have WebView2 yet. Upgrades install over older versions (fixed WiX upgrade code).

## First run

Users only need to pick **Sign in with Google**. Consent happens in their browser
through a loopback redirect with PKCE, and the refresh token is stored in Windows
Credential Manager. Every request then runs on the user's own Google token, so no API
key is needed.

### One-time setup (publisher only)

Google only shows a sign-in screen for an app registered with it, so the build has to
include an OAuth client ID:

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and
   enable **YouTube Data API v3**.
2. Under *Google Auth Platform*, configure the consent screen (External) and add the
   scope `.../auth/youtube.readonly`.
3. Under *Clients*, create a client of type **Desktop app**.
4. Copy `.env.example` to `.env.local`, fill in `VITE_GOOGLE_CLIENT_ID` and
   `VITE_GOOGLE_CLIENT_SECRET`, and run `pnpm tauri build`.

Notes:
- Until Google verifies the app, only accounts listed as *test users* (up to 100) can
  sign in. Submit the app for verification before releasing it publicly.
- All users share the project's quota of 10,000 units per day. Browsing costs about
  1 unit per request and a search costs 100. Google raises the limit on request
  (Quotas → YouTube Data API → apply for an audit).
- `VITE_YT_API_KEY` is optional. It only enables browsing while signed out.

## Controls

| Xbox controller | Keyboard | Browse | Player |
|---|---|---|---|
| D-pad / left stick | Arrows | Move (hold = accelerating repeat) | ◀ ▶ seek ±10 s (grows while held), ▲ ▼ volume |
| A | Enter / Space | Open | Play / pause |
| B | Esc / Backspace | Back; from the rail, exit | Back |
| Y | `/` | Search | Toggle layout (split ↔ theater) |
| X | – | – | Mute; after an error, open on YouTube |
| ☰ Menu | – | – | Up Next list |
| ⧉ View | `i` | – | Go to channel |
| LB / RB | `[` `]` | Previous / next tab | Previous (or restart) / next video |
| LT / RT | `,` `.` | – | Seek ±30 s |
| Right-stick click | F11 | Fullscreen | Fullscreen |

The mouse and wheel also work. The cursor hides after 2.5 s of inactivity.

## Architecture

```
src-tauri/src/
  lib.rs       window, localhost origin, navigation lock, single instance
  gamepad.rs   native controller input (gilrs, ~250 Hz) → "pad" events
  oauth.rs     Google OAuth (loopback + PKCE), Credential Manager storage
src/
  motion.ts    one rAF loop of frame-rate-independent springs
  input.ts     keyboard / wheel / pad → actions, TV-style accelerating repeat
  router.ts    tab roots (state preserved) + pushed screens + overlays
  ui/browse.ts shelves & grids: spatial focus, per-row memory, lazy thumbnails
  api.ts       Data API client: normalization, IndexedDB cache, quota meter
  screens/     home, subscriptions, search, library, channel, playlist, player, settings
```

What keeps it smooth:

- Only `transform` and `opacity` animate, so nothing triggers layout on a frame.
- Every scroll is a spring stepped on real elapsed time. Motion looks the same at 60, 144
  or 240 Hz, and changing direction mid-flight stays continuous.
- Thumbnails load only near the focus, backdrops are fully decoded before they fade
  in, and hidden screens are taken out of compositing.
- Controller input is read natively in Rust rather than through the web Gamepad API,
  so it keeps working when the YouTube iframe has focus. Input is ignored while the
  window is in the background.

## Findings from the REA recon

- **youtube.com/tv** now detects a spoofed TV user-agent and redirects desktop
  browsers away, so it can't be used as the base. Panorama has its own UI.
- **The IFrame player needs a real http origin plus a Referer.** Embeds from `tauri://` or
  file-like origins fail with *error 153*. A probe page served from
  `http://localhost` with `strict-origin-when-cross-origin` played normally:
  REA's console capture showed `ready` and then a quality change. That is why release
  builds serve the UI through `tauri-plugin-localhost` on a fixed port. Storage is
  per-origin, so the port must stay stable.

## Policy notes

- Panorama never draws over the player during playback. On ultrawide screens the
  info / up-next panel sits in the pillarbox area next to the video. In theater
  layout there's only a brief seek/volume indicator.
- There is no ad blocking and no stream extraction. YouTube's own player handles
  playback.
- Settings links to the YouTube Terms of Service, Google's Privacy Policy, and the page
  for revoking account access.
- The API has no watch history, home recommendations or Watch Later. Panorama's Home
  is built from regional trending charts plus your subscriptions feed.

## Develop

```sh
pnpm install
pnpm tauri dev          # desktop app with hot reload
pnpm dev                # browser only; open http://localhost:1420/?demo for fixture data
pnpm tauri build        # release build + MSI
```
