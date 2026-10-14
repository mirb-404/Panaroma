// Renders scene.html into public/startup/panorama-startup.webm.
//
//   node tools/startup-video/render.mjs
//
// Needs Microsoft Edge (or Chrome via EDGE_PATH) and ffmpeg on PATH. Each frame
// is drawn with window.render(t) and captured over the DevTools protocol, so
// motion is exact regardless of machine speed; the soundtrack is synthesized
// by the page with an OfflineAudioContext.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const out = join(root, "public", "startup", "panorama-startup.webm");
const FPS = 30;
const DURATION = 5.7;
const PORT = 9399;
const EDGE = process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const work = mkdtempSync(join(tmpdir(), "panorama-startup-"));
const frames = join(work, "frames");
mkdirSync(frames);

const browser = spawn(EDGE, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(work, "profile")}`,
  "--no-first-run",
  "--disable-sync",
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  "--window-size=1920,1080",
  pathToFileURL(join(here, "scene.html")).href,
]);

try {
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find((t) => t.type === "page" && t.url.endsWith("scene.html"));
    } catch {
      /* browser still starting */
    }
  }
  if (!page) throw new Error("Edge didn't start");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    pending.get(d.id)?.(d);
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };

  await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await evaluate("document.fonts.ready.then(() => true)");

  const total = Math.round(DURATION * FPS);
  for (let f = 0; f < total; f++) {
    await evaluate(`render(${f / FPS})`);
    const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } });
    writeFileSync(join(frames, `f${String(f).padStart(4, "0")}.png`), Buffer.from(shot.result.data, "base64"));
    if (f % 30 === 0) process.stdout.write(`frame ${f}/${total}\n`);
  }

  const wav = join(work, "audio.wav");
  writeFileSync(wav, Buffer.from(await evaluate("renderAudio()"), "base64"));
  ws.close();

  mkdirSync(dirname(out), { recursive: true });
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y", "-loglevel", "error",
      "-framerate", String(FPS), "-i", join(frames, "f%04d.png"),
      "-i", wav,
      "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30", "-row-mt", "1", "-deadline", "good", "-pix_fmt", "yuv420p",
      "-c:a", "libopus", "-b:a", "160k",
      "-shortest", out,
    ],
    { stdio: "inherit" },
  );
  if (ff.status !== 0) throw new Error("ffmpeg failed");
  console.log(`wrote ${out}`);
} finally {
  browser.kill();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(work, { recursive: true, force: true });
}
