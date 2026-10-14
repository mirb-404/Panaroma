# Panorama

A lean-back, controller-first YouTube client for Windows, designed for ultrawide
displays. Built on **Tauri v2** (Rust + WebView2) with a framework-free
TypeScript UI. Users sign in with their normal Google account (like a browser or
[ytmdesktop](https://github.com/ytmdesktop/ytmdesktop)); there is no API key, Google
Cloud project or quota. Playback uses the official **YouTube IFrame Player**.

## Install

Run `src-tauri/target/release/bundle/msi/Panorama_<version>_x64_en-US.msi`.
The installer bundles the WebView2 bootstrapper, so it also works on machines that
don't have WebView2 yet. Upgrades install over older versions (fixed WiX upgrade code).

## First run

After the startup movie, Panorama opens **Google's own sign-in page** in a small
window. Sign in as in any browser (password, 2-step verification and so on). The window
closes by itself, and your Home, subscriptions, history, Watch Later, likes and playlists
load into the TV interface. The session stays in the app's browser profile, so later
launches go straight to Home. **Settings → Account → Google account** signs out.

### How the data works

- The session cookies live in Panorama's WebView2 profile. The Rust side reads them and
  calls YouTube's web client API (`/youtubei/v1/browse|search|next`), the same interface
  youtube.com itself uses. Only Panorama's own UI can make these calls, and only for an
  allow-listed set of endpoints. YouTube pages never get access to the app's IPC.
- Responses are parsed by walking the whole renderer tree for known item types (classic
  renderers and the newer `lockupViewModel` format), so small layout changes don't break it.
- "Latest from your subscriptions" merges the newest uploads from each subscribed
  channel's public RSS feed, because this client receives the channel list rather than
  the video feed.
- This uses YouTube's internal web API, which is not an officially supported interface
  (the same approach as FreeTube and SmartTube). If YouTube changes it, parsing in
  `src/api.ts` may need updating.

## Video previews (Netflix-style)

Rest on a video (controller focus, or mouse hover, which also moves focus) and after
~0.5 s it starts playing muted in the big hero area at the top right. Screens without a
hero (search, channel and playlist grids) preview inside the card instead.

- Nothing of YouTube's player UI is visible. The frame is taller than the hero box, so
  the player's title bar sits in a letterbox band that is cropped away. The video is
  revealed only after the play/pause icon YouTube shows for the first ~4 s has gone.
- Pressing Ⓐ (or clicking) **hands the playing preview to the player**: the same iframe
  moves into the player with `Element.moveBefore` (no reload) and is unmuted, so
  playback simply continues. Without `moveBefore`, the player starts at the preview's
  position instead.
- Previews return to the image after 30 s. **Settings → Video previews** turns them off.

## Speed

- One pooled HTTP/2 connection with gzip/brotli (YouTube's JSON shrinks ~10×).
- Stale-while-revalidate cache: cached data up to a day old shows instantly while a
  fresh copy loads. Measured: Home's rows appear in ~0.3 s on a normal launch (~3 s with
  an empty cache).
- Home loads page by page, so the first row doesn't wait for the others.
- At startup, connections to YouTube's hosts are opened and the player code is
  downloaded once, so the first preview and the first video start faster.
- The player's description and Up next are prefetched while focus rests on a video.

## Staying working when YouTube changes

The design follows ytmdesktop, which survives YouTube updates by leaning on YouTube's
own UI wherever possible:

- **Tolerant parsing.** Items are found anywhere in a response by renderer type. If
  YouTube renames its renderers, a generic extractor still builds basic cards from any
  object carrying a video ID and title, so rows degrade instead of going empty.
- **Stable inputs.** The web client version is read from youtube.com at runtime.
  Subscription uploads come from public RSS feeds. Thumbnails use fixed `i.ytimg.com`
  URL patterns.
- **YouTube's own page as the safety net.** Videos whose creators block embedding open
  in Panorama's **in-app YouTube view**: youtube.com in a full-window, controller-ready
  view (only the player is shown on watch pages; Ⓑ/Esc returns). Every "Couldn't load"
  screen also offers **Open on YouTube**. The view's injected script only touches the
  `<video>` element and container IDs, and YouTube pages have no access to Panorama's
  commands (verified: the ACL denies them).

## Sounds & startup

- **UI sounds** (Settings → Sound & startup): *Panorama* (the default) is a
  built-in pack synthesized with WebAudio, so it needs no audio files. *Steam Big
  Picture* plays the sounds from the user's own Steam installation, found through the
  registry and read at runtime from `steamui\sounds`. Panorama never bundles or
  redistributes them, and falls back to its own pack when Steam isn't installed.
  *Off* disables UI sounds. Volume is adjustable.
- **Startup**: the Panorama startup movie (`public/startup/panorama-startup.webm`,
  rendered from `tools/startup-video/scene.html` with `node tools/startup-video/render.mjs`,
  which needs Edge and ffmpeg), **your own video** (MP4/WebM/MOV, picked with a
  file dialog and copied into app data, like Big Picture's startup movies), or
  nothing. Any button skips it, and *Preview startup* replays it.

## Installer

`pnpm tauri build` produces a standard MSI: **Welcome → choose install folder →
Install → Finish** (with an optional "Launch Panorama" box). No license page and no
extras. The installer artwork (`src-tauri/installer/*.bmp`) is rendered from
`tools/installer-art/art.html` with `node tools/installer-art/render.mjs`. Bump
`version` in `src-tauri/tauri.conf.json` for each release so the MSI upgrades in place.

## Controls

Any controller with a standard layout works, including one Windows exposes twice (a PlayStation pad plus its DS4Windows/ViGEm virtual Xbox twin counts as one controller): Xbox, PlayStation (DualShock 4 /
DualSense, ✕ ○ □ △ = A B X Y), Switch Pro and most others. Input comes from the
web Gamepad API, with native XInput/Windows.Gaming.Input (Rust) as a backup that is
only used while the web API sees no controller. If Steam is running with Steam Input
enabled for your controller, Steam may capture it; disable Steam Input for desktop use
if Panorama doesn't respond.

| Xbox controller | Keyboard | Browse | Player |
|---|---|---|---|
| D-pad / left stick | Arrows | Move (hold = accelerating repeat) | ◀ ▶ seek ±10 s (grows while held), ▲ ▼ volume |
| A | Enter / Space | Open | Play / pause |
| B | Esc / Backspace | Back; from the rail, exit | Back |
| Y | `/` | Search | Toggle layout (split ↔ theater) |
| X | – | – | Mute; after an error, open on YouTube |
| ☰ Start / Options | – | **Settings** (press again to go back) | Up Next list |
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
  youtube.rs   Google sign-in window, session cookies → youtubei API, RSS feeds
  media.rs     Steam UI sounds (read from the user's Steam), custom startup video
src/
  motion.ts    one rAF loop of frame-rate-independent springs
  input.ts     keyboard / wheel / pad → actions, TV-style accelerating repeat
  router.ts    tab roots (state preserved) + pushed screens + overlays
  ui/browse.ts shelves & grids: spatial focus, per-row memory, lazy thumbnails
  api.ts       YouTube web client: renderer parsing, normalization, IndexedDB cache
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
- Data comes from YouTube's internal web API with the user's own session; see
  "How the data works" above.

## Develop

```sh
pnpm install
pnpm tauri dev          # desktop app with hot reload
pnpm dev                # browser only; open http://localhost:1420/?demo for fixture data
pnpm tauri build        # release build + MSI
```
