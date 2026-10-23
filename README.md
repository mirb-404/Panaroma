# Panorama

*By Mirang Bhandari*

Panorama is a lean-back YouTube client for Windows. It's built for the couch and for
ultrawide displays, and works with a controller, a keyboard or a mouse, each on its own
or together. You sign in with your normal Google account, and your recommendations,
subscriptions, history, Watch Later, likes and playlists show up in a TV-style
interface. Playback uses YouTube's official embedded player.

Built with **Tauri v2** (Rust + WebView2) and a framework-free TypeScript UI.

## Features

- **TV-style browsing.** Home, Subscriptions, Search and Library, made of rows you
  scroll through with springy, frame-rate-independent motion. Every row remembers
  where you left it.
- **Video previews.** Rest on a video for a moment and it plays muted. On Home,
  Subscriptions and Library it plays in the large hero area at the top right; on
  search, channel and playlist pages it plays inside the card. Opening the video
  continues the preview without reloading.
- **Player.**
  - Two layouts: **Full**, and **Side panel**, with the video's info and Up next beside
    the video.
  - **Side panel** works with every device: Tab or a left-stick click moves into it.
    ▲ ▼ go between the channel, the Like / Save / Comments / Subscribe buttons, the
    description and the Up next · Comments · Live chat tabs; ◀ ▶ move along buttons and
    tabs; Ⓐ / Enter activates. The mouse clicks and scrolls everything directly.
  - **Comments** with their replies: Ⓐ, Enter or a click on a comment opens its replies.
  - **Live streams:** live chat (or a finished stream's chat replay, in step with the
    video), Super Chats, memberships and the pinned message; writing in the chat with
    the on-screen keyboard or a physical one; viewer count; how far behind live you are,
    and **Go live** in the ☰ menu.
  - **Fill ultrawide screens** zooms 16:9 video to fill wide displays while keeping
    captions and controls in view.
  - Playback settings: captions, caption size, speed and quality (every quality YouTube
    offers, HDR included).
  - Autoplay with a short countdown, and seek and volume indicators.
- **Miniplayer.** Going back from the player docks the video in a corner while you keep
  browsing.
- **YouTube fallback.** Some creators allow playback only on youtube.com. Their videos
  open in Panorama's built-in YouTube view, and the queue continues when you return.
- **First-run welcome.** After you sign in, a short guided tour of the controls for your
  device: controller, keyboard or mouse.
- **Sounds and startup.** Built-in UI sounds, or the sounds from your own Steam
  installation. Also a startup movie, your own startup video, or none.

## Install

Run `Panorama_<version>_x64_en-US.msi`. The installer is a standard Welcome → Folder →
Install → Finish wizard. It includes the WebView2 bootstrapper, so it also works on PCs
without WebView2. New versions install over old ones.

## First run

1. The startup movie plays. Any button, key or click skips it.
2. Google's own sign-in page opens in a small window. Sign in as you would in a browser.
   The window closes by itself and your YouTube content loads. Later launches go
   straight to Home.
3. Panorama says **Welcome to Panorama** and tours the controls. The screen fades
   behind a vignette, a spotlight opens on each part of the interface and an arrow
   points at it. The tour matches your device: a connected controller wins, otherwise
   the keyboard or mouse you last used. You can switch device on the tour's card.

Replay any of the three tours from **Settings → Controls**. Sign out from
**Settings → Account**.

## Controls

Everything works with only a controller, only a keyboard or only a mouse.

| Controller (Xbox labels) | Keyboard | Mouse | Browsing | In the player |
|---|---|---|---|---|
| D-pad / left stick | Arrows | Hover, wheel, ‹ › at a row's ends | Move (hold to speed up) | ◀ ▶ seek ±10 s (grows while held), ▲ ▼ volume |
| A | Enter / Space | Click a selected card | Open | Play / pause |
| B | Esc / Backspace | ← button (top-left) or mouse back button | Back; from the menu, exit | Back (docks the miniplayer) |
| Y | `/` | Click Search | Search | Switch layout |
| X | `X` | – | – | Mute; after an error, open on YouTube |
| ☰ Menu / Options | `S` | Click ⚙ in the menu | **Settings** (again to go back) | **Playback settings** (right-click or the player's gear) |
| ⧉ View | `I` | Click the channel name | – | Go to the channel |
| LB / RB | `[` `]` | Click a tab in the menu | Previous / next tab | Previous (or restart) / next video |
| LT / RT | `,` `.` | YouTube's seek bar | – | Seek ±30 s |
| Left-stick click | Tab | – | – | Move into the side panel (again, or Ⓑ, to leave) |
| Right-stick click | F11 | – | Fullscreen | Fullscreen |

In the player, YouTube's own keys also work: `K` play/pause, `J` / `L` seek,
`M` mute, `C` captions, `F` fullscreen.

- **Controllers:** Xbox, PlayStation (✕ ○ □ △ act as A B X Y), Switch Pro and most
  others. A pad that Windows shows twice (e.g. DS4Windows plus its virtual Xbox pad)
  counts as one.
- **Steam Input:** if it's enabled for your controller, Steam may capture the
  controller. Turn it off for desktop use if Panorama doesn't respond.
- **Mouse:**
  - Hovering only selects cards that are fully on screen, so a cursor resting at
    either end of a row never scrolls it.
  - The cursor and the back button hide after 2.5 s without movement.

## Settings

- **Account:** sign in or out.
- **Display:**
  - Region
  - Interface size
  - Fill ultrawide screens
  - Start in fullscreen (on by default)
  - Reduced motion
  - Video previews
  - Autoplay next video
- **Sound & startup:**
  - UI sounds: *Panorama*, *Steam Big Picture* or *Off*. The Steam sounds are read from
    your own Steam installation, never bundled, and fall back to Panorama's own sounds
    if Steam isn't installed.
  - Volume
  - Startup: the Panorama movie, your own video (MP4, WebM or MOV; Panorama keeps a
    copy) or nothing
  - Preview startup
- **Controls:** the controller, keyboard and mouse tutorials.
- **Data:** clear the cache and the search history.
- **About:**
  - The YouTube Terms of Service, Google's Privacy Policy, and the page for revoking
    account access
  - Version
  - Quit

## How it works

- **Sign-in.**
  - The session lives in Panorama's WebView2 profile.
  - The Rust side reads its cookies and calls YouTube's web client API
    (`/youtubei/v1/browse|search|next|guide`, the interface youtube.com itself uses).
    Only an allow-listed set of endpoints can be called, and only Panorama's own UI
    can call them.
  - YouTube pages have no access to the app's commands.
  - There is no API key, Google Cloud project or quota.
- **Parsing.** Responses are searched for known item types, including the newer
  `lockupViewModel` format. If YouTube renames them, a generic fallback still builds
  basic cards from anything with a video ID and title, so rows degrade instead of going
  empty.
- **Subscriptions.** "Latest from your subscriptions" merges each subscribed channel's
  public RSS feed.
- **Speed.**
  - One pooled HTTP/2 connection with gzip and brotli.
  - A stale-while-revalidate cache in IndexedDB: data up to a day old shows instantly
    while a fresh copy loads.
  - Home loads row by row.
  - At startup, connections to YouTube's servers are opened and the player code is
    downloaded once.
  - Up next is prefetched while you rest on a video.
- **Embedded player.**
  - A small script injected into YouTube's embedded player hides YouTube's overlays
    during previews.
  - It sends the player's gear button to Panorama's playback menu.
  - It keeps captions and controls in view when the video is zoomed.
  - It lists and applies quality choices, which the official player API can't set.
  - It uses only long-stable hooks. If those change, the player behaves like a normal
    embed.
- **Input.**
  - Keyboard, mouse wheel and controllers feed one action stream, with TV-style
    accelerating repeat.
  - Controllers are read through the web Gamepad API, with native input from Rust
    (gilrs) as a backup while the web API sees no controller.
  - Input is ignored while the window is in the background.
- **Rendering.** Only `transform` and `opacity` animate, every scroll is a spring
  stepped on real elapsed time, thumbnails load only near the focus, and hidden screens
  are taken out of compositing.
- **Local origin.** YouTube's embedded player refuses `tauri://` origins (error 153), so
  release builds serve the UI from `http://localhost` on a fixed port. Storage is
  per-origin, so the port must stay stable.

This relies on YouTube's internal web API, which isn't an officially supported interface
(the same approach as FreeTube and SmartTube). If YouTube changes it, `src/api.ts` may
need updating.

## Policy notes

- No ad blocking and no stream extraction. YouTube's own player handles playback.
- Panorama never draws over the video during playback. The side panel sits beside the
  video, and the full layout shows only brief seek and volume indicators.
- Panorama is not affiliated with or endorsed by YouTube or Google.

## Develop

```sh
pnpm install
pnpm tauri dev      # desktop app with hot reload
pnpm dev            # browser only; open http://localhost:1420/?demo for sample data
pnpm tauri build    # release build + MSI
```

For each release, bump `version` in `package.json`, `src-tauri/Cargo.toml` and
`src-tauri/tauri.conf.json` so the MSI upgrades in place.

To regenerate the artwork (both need Edge and ffmpeg):

- **Startup movie** (`public/startup/panorama-startup.webm`): run
  `node tools/startup-video/render.mjs`.
- **Installer art** (`src-tauri/installer/*.bmp`): run
  `node tools/installer-art/render.mjs`.

### Code signing

`pnpm tauri build` signs `panorama.exe` and the MSI with Authenticode (SHA-256 with an
RFC 3161 timestamp) through `src-tauri/scripts/sign.ps1`. The certificate comes from the
environment, so no secret is committed:

```powershell
$env:PANORAMA_SIGN_THUMBPRINT = '<thumbprint>'   # cert in Cert:\CurrentUser\My
# or
$env:PANORAMA_SIGN_PFX = 'C:\certs\panorama.pfx'; $env:PANORAMA_SIGN_PFX_PASSWORD = '...'
$env:PANORAMA_REQUIRE_SIGNING = '1'               # optional: fail instead of building unsigned
pnpm tauri build
```

Without a certificate, the build still succeeds unsigned, with a warning.

- **Local testing:** `src-tauri/scripts/new-dev-cert.ps1` creates a self-signed
  certificate. Other PCs show builds signed with it as "Unknown publisher".
- **Public releases:** these need a certificate from a trusted provider, or Azure
  Trusted Signing.

### Project layout

```
src-tauri/src/
  lib.rs          window, localhost origin, navigation lock, single instance
  gamepad.rs      native controller input (gilrs, ~250 Hz) and controller presence
  youtube.rs      Google sign-in window, session → youtubei API, RSS feeds, YouTube view
  media.rs        Steam UI sounds, custom startup video
  ytembed.js      script for YouTube's embedded player (previews, quality, gear button)
  ytview.js       script for the in-app YouTube view
src/
  main.ts         startup, sign-in, first-run welcome
  input.ts        keyboard / mouse / controller → actions, accelerating repeat
  router.ts       tab roots (state kept) + pushed screens + overlays + miniplayer
  api.ts          YouTube web client: parsing, normalization, cache
  motion.ts       one rAF loop of frame-rate-independent springs
  sound.ts        UI sound packs (synthesized or from Steam)
  ui/             browse rows, cards, previews, rail, startup intro, tutorial, text entry
  screens/        home, subscriptions, search, library, channel, playlist, player, settings
```

## License

Copyright © 2026 Mirang Bhandari

Panorama is free software: you can redistribute it and/or modify it under the terms of
the GNU General Public License as published by the Free Software Foundation, either
version 3 of the License, or (at your option) any later version. It is distributed in
the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied
warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE)
for the full text.
