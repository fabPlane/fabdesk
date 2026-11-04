/** Browser Worker/Blob transport adapter only; the production worker code runs unchanged in Node threads. */
import assert from "node:assert/strict";
import { readFile, readdir, rm } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Worker as Thread } from "node:worker_threads";

const active = new Set();
const workerUrls = [];
class BrowserWorker {
  onmessage = null;
  onerror = null;
  stopped = false;
  listeners = new Map();
  constructor(url) {
    active.add(this);
    workerUrls.push(String(url));
    // Fetch immediately: Vite revokes the creating page's Blob URL after construction.
    const text =
      String(url).startsWith("blob:") || String(url).startsWith("data:")
        ? fetch(url).then((response) => response.text())
        : readFile(new URL(url), "utf8");
    this.ready = text.then((source) => {
      if (this.stopped) return null;
      this.thread = new Thread(
        `
const {parentPort, workerData} = require("node:worker_threads");
globalThis.self = globalThis;
globalThis.location = { href: workerData.href };
globalThis.postMessage = (data) => parentPort.postMessage(data);
parentPort.on("message", (data) => globalThis.onmessage?.({ data }));
${source}
`,
        { eval: true, workerData: { href: String(url) } },
      );
      this.thread.on("message", (data) => this.emit("message", { data }));
      this.thread.on("error", (error) => this.emit("error", error));
      return this.thread;
    });
    this.ready.catch((error) => this.emit("error", error));
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type, event) {
    this[`on${type}`]?.(event);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  postMessage(data) {
    void this.ready.then((thread) => thread?.postMessage(data)).catch(() => {});
  }
  terminate() {
    this.stopped = true;
    active.delete(this);
    return this.thread?.terminate();
  }
}
globalThis.Worker = BrowserWorker;
globalThis.self = globalThis;
globalThis.window = globalThis;

function message(worker, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => done(new Error("Production worker did not answer within 10 seconds")),
      10_000,
    );
    const done = (error, data) => {
      clearTimeout(timer);
      worker.terminate();
      error ? reject(error) : resolve(data);
    };
    worker.onmessage = ({ data }) => done(null, data);
    worker.onerror = (error) => done(error);
    worker.postMessage(payload);
  });
}

try {
  const entry = resolve(process.argv[2]);
  const outputParts = relative(tmpdir(), dirname(entry)).split(sep);
  assert.equal(basename(entry), "entry.mjs");
  assert.equal(outputParts.length, 2);
  assert.ok(outputParts[0].startsWith("fabdesk-production-workers-"));
  assert.equal(outputParts[1], "dist");
  const { makeLayoutWorker, makeFileWorker, placementJob, defaultEnclosureDesign } = await import(
    pathToFileURL(entry)
  );
  const boardText = await readFile(process.argv[3], "utf8");
  // Match a running page whose original renderer and worker hashes were removed by a rebuild.
  // The imported module remains in memory; no emitted auxiliary asset can be read afterward.
  await rm(dirname(entry), { recursive: true, force: true });
  const externalFiles = await readdir(dirname(entry)).catch(() => []);
  assert.equal(externalFiles.length, 0);
  const boards = ["controller.kicad_pcb", "usb-dongle.kicad_pcb"].map((path, i) => ({
    placement: { path, x: 100, y: 100, z: 5, rotation: 0 },
    features: {
      pcbRevision: path,
      thicknessMm: 1.6,
      outline: {
        minX: 0,
        minY: 0,
        maxX: i ? 12 : 40,
        maxY: i ? 8 : 20,
        widthMm: i ? 12 : 40,
        heightMm: i ? 8 : 20,
      },
      holes: [],
      components: [],
      connectors: [],
    },
  }));
  const design = defaultEnclosureDesign(null);
  design.boards = boards.map((board) => board.placement);
  const choices = await message(makeLayoutWorker(), { design, boards, goal: "compact" });
  assert.equal(choices.length, 1);
  assert.equal(choices[0].goal, "compact");
  assert.equal(choices[0].error, undefined);
  assert.equal(choices[0].proposal.design.boards.length, 2);
  assert.ok(choices[0].proposal.design.space.width > 0);
  assert.notDeepEqual(choices[0].proposal.design.boards, design.boards);

  const controller = new AbortController();
  const loaded = await placementJob(
    { kind: "load", text: boardText, name: "usb-timer.kicad_pcb" },
    controller.signal,
  );
  assert.equal(loaded.session.parts.length, 12);
  const resized = await placementJob(
    { kind: "resize", session: loaded.session, w: 40, h: 30, adjust: true },
    controller.signal,
  );
  assert.deepEqual([resized.session.board.w, resized.session.board.h], [40, 30]);
  const exported = await placementJob(
    { kind: "export", session: resized.session },
    controller.signal,
  );
  const reopened = await placementJob(
    { kind: "load", text: exported.text, name: "resized.kicad_pcb" },
    controller.signal,
  );
  assert.deepEqual([reopened.session.board.w, reopened.session.board.h], [40, 30]);
  assert.equal(reopened.session.parts.length, 12);
  assert.equal(workerUrls.length, 5);
  assert.ok(
    workerUrls.every((url) => url.startsWith("blob:")),
    "Inline jobs must use the browser's Blob worker path, not data: fallback",
  );
  await assert.rejects(
    message(makeFileWorker(), { design, boards, goal: "compact" }),
    /ENOENT|file|fetch/i,
  );
  console.log(
    JSON.stringify({
      enclosureBoards: 2,
      placementParts: 12,
      resized: [40, 30],
      staleFileWorkerRejected: true,
      externalFilesAfterLoad: externalFiles.length,
    }),
  );
} finally {
  await Promise.all([...active].map((worker) => worker.terminate()));
}
