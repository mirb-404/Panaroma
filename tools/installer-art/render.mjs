// Renders art.html into the WiX installer bitmaps.
//   node tools/installer-art/render.mjs      (needs Microsoft Edge and ffmpeg)
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../src-tauri/installer");
const EDGE = process.env.EDGE_PATH ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 9398;
const work = mkdtempSync(join(tmpdir(), "panorama-art-"));
const browser = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(work, "p")}`, "--no-first-run", "--disable-sync", "--force-device-scale-factor=1", pathToFileURL(join(here, "art.html")).href]);
try {
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.url.endsWith("art.html")); } catch {}
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Emulation.setDeviceMetricsOverride", { width: 600, height: 500, deviceScaleFactor: 1, mobile: false });
  await new Promise((r) => setTimeout(r, 600));
  for (const [name, sel] of [["dialog", "#dialog"], ["banner", "#banner"]]) {
    const box = (await send("Runtime.evaluate", { expression: `JSON.stringify(document.querySelector('${sel}').getBoundingClientRect())`, returnByValue: true })).result.result.value;
    const { x, y, width, height } = JSON.parse(box);
    const shot = await send("Page.captureScreenshot", { format: "png", clip: { x, y, width, height, scale: 1 } });
    const png = join(work, `${name}.png`);
    writeFileSync(png, Buffer.from(shot.result.data, "base64"));
    // WiX needs 24-bit BMP.
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", png, "-pix_fmt", "bgr24", join(out, `${name}.bmp`)], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("ffmpeg failed");
    console.log(`wrote ${name}.bmp (${width}x${height})`);
  }
  ws.close();
} finally {
  browser.kill();
  await new Promise((r) => setTimeout(r, 400));
  rmSync(work, { recursive: true, force: true });
}
