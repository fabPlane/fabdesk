import { expect, test } from "bun:test";
import { PreviewQueue } from "./preview-queue";
import { previewInputStamp, runPreviewTool } from "./live-previews";
import type { CoreClient } from "./CoreClient";

test("native exports are serial, drawings precede waiting models, and superseded jobs never start", async () => {
  const queue = new PreviewQueue(), active = new AbortController(), old = new AbortController();
  let release!: () => void, running = 0, maximum = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const work = async (name: string, wait = false) => {
    maximum = Math.max(maximum, ++running); order.push(name);
    if (wait) await gate;
    running--; return name;
  };
  const first = queue.enqueue(3, active.signal, () => work("running model", true));
  const stale = queue.enqueue(3, old.signal, () => work("obsolete model")).catch(error => error.name);
  const latest = queue.enqueue(3, active.signal, () => work("latest model"));
  const drawing = queue.enqueue(0, active.signal, () => work("latest drawing"));
  old.abort(); release();
  expect(await Promise.all([first, stale, latest, drawing])).toEqual(["running model", "AbortError", "latest model", "latest drawing"]);
  expect(order).toEqual(["running model", "latest drawing", "latest model"]);
  expect(maximum).toBe(1);
});

test("a failed renderer releases the queue so another preview can still load", async () => {
  const queue = new PreviewQueue(), signal = new AbortController().signal;
  const failed = queue.enqueue(0, signal, async () => { throw new Error("missing sheet"); }).catch(error => error.message);
  const model = queue.enqueue(3, signal, async () => "model");
  expect(await Promise.all([failed, model])).toEqual(["missing sheet", "model"]);
});

test("output writes cannot produce a render loop, while nested sheets, models and libraries invalidate inputs", () => {
  const file = (path: string, mtime = "1") => ({ path, mtime, size: 100 });
  const initial = [file("board.kicad_pcb"), file("sheets/power.kicad_sch"), file("models/usb.step"), file("fp-lib-table")];
  const stamp = previewInputStamp(initial);
  expect(previewInputStamp([...initial].reverse())).toBe(stamp);
  expect(previewInputStamp([...initial, file("renders/pcb.svg"), file("renders/board.glb"), file("exports/board.kicad_pcb")])).toBe(stamp);
  for (const path of ["sheets/power.kicad_sch", "models/usb.step", "fp-lib-table"])
    expect(previewInputStamp(initial.map(row => row.path === path ? file(path, "2") : row))).not.toBe(stamp);
});

test("immediate tool errors are not treated as successful generation", async () => {
  const client = { callTool: async () => ({ result: { isError: true, text: "Source changed" } }) } as unknown as CoreClient;
  await expect(runPreviewTool(client, "render_glb", {})).rejects.toThrow("Source changed");
});

test("direct HTTP tool envelopes retain the scoped inspection used by assembly rendering", async () => {
  const result = { ok: true, json: { _board: { sourceId: "io" }, hierarchy: { complete: true } } };
  const client = { callTool: async () => result } as unknown as CoreClient;
  expect(await runPreviewTool(client, "schematic_inspect", {})).toBe(result);
});
