# Panorama

*By Mirang Bhandari*

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

Once signed in, Panorama says **Welcome to Panorama** and gives a short controls
tour: the screen fades behind a vignette, a spotlight opens on each part of the
interface (rows, the preview area, the menu, Settings, Search) and an arrow points at
it. The tour matches the device in use (a connected controller wins, otherwise the
keyboard or mouse you last touched), and the card can switch device at any time.
**Settings → Controls** replays the controller, keyboard or mouse tour.

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
`version` in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` for
each release so the MSI upgrades in place.

The installer and app are published as **Mirang Bhandari** (publisher, copyright and
file properties).

### Code signing

`pnpm tauri build` signs `panorama.exe` and the MSI with Authenticode (SHA-256, RFC 3161
timestamp) through `src-tauri/scripts/sign.ps1`. The certificate comes from the
environment, so no secret is committed:

```powershell
$env:PANORAMA_SIGN_THUMBPRINT = '<thumbprint>'   # cert in Cert:\CurrentUser\My
# or
$env:PANORAMA_SIGN_PFX = 'C:\certs\panorama.pfx'; $env:PANORAMA_SIGN_PFX_PASSWORD = '...'
$env:PANORAMA_REQUIRE_SIGNING = '1'               # optional: fail instead of building unsigned
pnpm tauri build
```

Without a certificate the build still succeeds, unsigned, with a warning. For local
testing, `src-tauri/scripts/new-dev-cert.ps1` creates a self-signed certificate (other
PCs show it as an unknown publisher). Public releases need a certificate from a trusted
CA or Azure Trusted Signing so SmartScreen shows the publisher name.

## Controls

Any controller with a standard layout works, including one Windows exposes twice (a PlayStation pad plus its DS4Windows/ViGEm virtual Xbox twin counts as one controller): Xbox, PlayStation (DualShock 4 /
DualSense, ✕ ○ □ △ = A B X Y), Switch Pro and most others. Input comes from the
web Gamepad API, with native XInput/Windows.Gaming.Input (Rust) as a backup that is
only used while the web API sees no controller. If Steam is running with Steam Input
enabled for your controller, Steam may capture it; disable Steam Input for desktop use
if Panorama doesn't respond.

Each device works on its own: everything can be done with only a controller, only a
keyboard or only a mouse, and they can be mixed freely.

| Xbox controller | Keyboard | Mouse | Browse | Player |
|---|---|---|---|---|
| D-pad / left stick | Arrows | Hover, wheel, ‹ › at a row's ends | Move (hold = accelerating repeat) | ◀ ▶ seek ±10 s (grows while held), ▲ ▼ volume |
| A | Enter / Space | Click (a selected card) | Open | Play / pause |
| B | Esc / Backspace | ← button (top-left) or mouse back button | Back; from the rail, exit | Back (docks a miniplayer) |
| Y | `/` | Click Search | Search | Toggle layout (split ↔ theater) |
| X | `X` | – | – | Mute; after an error, open on YouTube |
| ☰ Start / Options | `S` | Click ⚙ / right-click in the player | **Settings** (press again to go back) | **Playback settings**: captions, speed, quality, ultrawide fill, layout, Up next |
| ⧉ View | `i` | Click the channel name | – | Go to channel |
| LB / RB | `[` `]` | Click a tab in the menu | Previous / next tab | Previous (or restart) / next video |
| LT / RT | `,` `.` | YouTube's seek bar | – | Seek ±30 s |
| Right-stick click | F11 | – | Fullscreen | Fullscreen |

Hovering only selects cards that are fully on screen, so a cursor resting at either
edge of a row never scrolls it; the ‹ › arrows page through a row instead. The cursor
and the back button hide after 2.5 s without mouse movement.

## Architecture

```
src-tauri/src/
  lib.rs       window, localhost origin, navigation lock, single instance
  gamepad.rs   native controller input (gilrs, ~250 Hz) → "pad" events, pad presence
  youtube.rs   Google sign-in window, session cookies → youtubei API, RSS feeds
  media.rs     Steam UI sounds (read from the user's Steam), custom startup video
src/
  motion.ts    one rAF loop of frame-rate-independent springs
  input.ts     keyboard / wheel / pad → actions, TV-style accelerating repeat
  router.ts    tab roots (state preserved) + pushed screens + overlays
  ui/browse.ts shelves & grids: spatial focus, per-row memory, lazy thumbnails
  ui/tutorial.ts first-run welcome and per-device controls tour
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

## Author

Panorama is made by **Mirang Bhandari**.

## License

Copyright © 2026 Mirang Bhandari

Panorama is free software: you can redistribute it and/or modify it under the terms of
the GNU General Public License as published by the Free Software Foundation, either
version 3 of the License, or (at your option) any later version. It is distributed in
the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE)
for the full text.

**Additional permission under GNU GPL version 3 section 7:** if you modify this
program, or any covered work, by linking or combining it with the Steamworks SDK (or a
modified version of that library), containing parts covered by the terms of the
Steamworks SDK license, the licensors of this program grant you additional permission
to convey the resulting work.
Panorama is not affiliated with or endorsed by YouTube or Google.
