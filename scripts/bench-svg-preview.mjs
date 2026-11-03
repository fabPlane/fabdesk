/** Run from the repo root: bun scripts/bench-svg-preview.mjs <desktop-userData-directory> */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const directory = process.argv[2];
if (!directory) throw new Error("Pass the running dev app's userData directory (see docs/app-automation.md).");
const bridge = JSON.parse(await readFile(join(directory, "app-bridge.json"), "utf8"));
const daemon = JSON.parse(await readFile(join(directory, "daemon.json"), "utf8"));
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(bridge.url)) throw new Error("Expected a local desktop bridge.");

async function measurePreview() {
  if (!window.__fabdeskApp) throw new Error("Enable the app's dev automation bridge first.");
  if (document.querySelector('[data-testid="comment-detail"]')) throw new Error("Close the comment editor before benchmarking.");
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  await window.__fabdeskApp.openTab("schematic");
  await wait(300);
  if (!document.querySelector(".fd-svg-host")) throw new Error("Open a project with a rendered schematic first.");
  const frames = [], longTasks = [];
  let last = performance.now(), running = true;
  const tick = time => {
    frames.push(time - last);
    last = time;
    if (running) requestAnimationFrame(tick);
  };
  const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration)));
  observer.observe({ type: "longtask" });
  requestAnimationFrame(tick);
  const click = selector => {
    const button = document.querySelector(selector);
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing control: ${selector}`);
    button.click();
  };
  try {
    for (let round = 0; round < 3; round++) {
      click(".fd-board-toggle"); await wait(350);
      click(".fd-board-toggle"); await wait(400);
    }
    for (let step = 0; step < 8; step++) { click('button[title="Zoom in"]'); await wait(85); }
    for (let step = 0; step < 8; step++) { click('button[title="Zoom out"]'); await wait(85); }
    [...document.querySelectorAll("button")].find(button => button.textContent.trim() === "Fit")?.click();
    await wait(250);
    frames.sort((a, b) => a - b);
    return {
      frames: frames.length,
      p95FrameMs: frames[Math.floor(frames.length * 0.95)],
      maxFrameMs: Math.max(...frames),
      framesOver33Ms: frames.filter(ms => ms > 33).length,
      longTasksMs: longTasks,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    };
  } finally { running = false; observer.disconnect(); }
}

const response = await fetch(`${bridge.url}/eval`, {
  method: "POST",
  headers: { Authorization: `Bearer ${daemon.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ code: `(${measurePreview.toString()})()` }),
});
if (!response.ok) throw new Error(`Benchmark failed (${response.status}): ${await response.text()}`);
console.log(JSON.stringify((await response.json()).result, null, 2));
