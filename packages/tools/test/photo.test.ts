import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { encodePng } from "@fabdesk/board-art";
import type { SightedItem } from "@fabdesk/protocol";
import { createRegistry, FakeVisionProvider, fitOutlineFromMask, inferScale, maskFromGray } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

function rectPng(width = 80, height = 50, inset = 6): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const board = x >= inset && x < width - inset && y >= inset && y < height - inset;
      const i = (y * width + x) * 4;
      const v = board ? 20 : 240;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return encodePng({ width, height, data });
}

const items: SightedItem[] = [
  {
    id: "usb1",
    kind: "connector",
    label: "USB-C",
    side: "front",
    box: { x: 0.05, y: 0.4, w: 0.12, h: 0.2 },
    confidence: 0.9,
  },
  {
    id: "led1",
    kind: "led",
    label: "LED",
    side: "front",
    box: { x: 0.45, y: 0.4, w: 0.1, h: 0.12 },
    confidence: 0.8,
  },
  {
    id: "r1",
    kind: "passive",
    label: "0805 resistor",
    side: "front",
    box: { x: 0.6, y: 0.45, w: 0.08, h: 0.06 },
    confidence: 0.6,
  },
];

describe("outline fitting", () => {
  test("fits a rectangle silhouette to four corners", () => {
    const width = 20;
    const height = 12;
    const pixels = new Uint8Array(width * height);
    for (let y = 2; y < 10; y++) {
      for (let x = 3; x < 17; x++) pixels[y * width + x] = 1;
    }
    const outline = fitOutlineFromMask({ width, height, pixels }, 1, 0.6);
    expect(outline.source).toBe("silhouette");
    expect(outline.polygon.length).toBeGreaterThanOrEqual(4);
    const xs = outline.polygon.map((p) => p.x);
    const ys = outline.polygon.map((p) => p.y);
    expect(Math.min(...xs)).toBe(3);
    expect(Math.max(...xs)).toBe(16);
    expect(Math.min(...ys)).toBe(2);
    expect(Math.max(...ys)).toBe(9);
  });

  test("maskFromGray treats dark pixels as board", () => {
    const mask = maskFromGray(2, 1, new Uint8Array([10, 250]), 200);
    expect([...mask.pixels]).toEqual([1, 0]);
  });
});

describe("scale inference", () => {
  test("uses a user-given width", () => {
    const scale = inferScale({
      photoWidthPx: 200,
      photoHeightPx: 100,
      items: [],
      hint: { userDimensionMm: 40, userDimensionOf: "width" },
    });
    expect(scale.method).toBe("user_dimension");
    expect(scale.boardWidthMm).toBe(40);
    expect(scale.boardHeightMm).toBe(20);
  });

  test("infers millimetres from a USB-C box", () => {
    const scale = inferScale({
      photoWidthPx: 100,
      photoHeightPx: 50,
      items,
    });
    expect(scale.method).toBe("known_part");
    expect(scale.knownPart).toBe("usb_c");
    expect(scale.boardWidthMm).toBeGreaterThan(20);
    expect(scale.note).toContain("USB-C");
  });
});

describe("photo MCP tools", () => {
  test("photo_analyze writes a what-I-see sighting from a fake provider", async () => {
    const project = await tempProject("photo-analyze");
    const sketches = join(project.dir, "sketches");
    await mkdir(sketches, { recursive: true });
    await Bun.write(join(sketches, "front.png"), rectPng());
    const base = mockServices([project]);
    const services = mockServices([project], {
      vision: new FakeVisionProvider(items),
      design: base.design,
      kicad: base.kicad,
    });
    const factory = contextFactory(services, project);
    const reg = createRegistry();
    const out = await reg.invoke(
      "photo_analyze",
      { photos: ["sketches/front.png"], description: "A USB LED badge" },
      (ref) =>
        factory({
          def: reg.get("photo_analyze")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
    );
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain("What I see");
    expect(out.text).toContain("USB-C");
    const json = out.json as { sighting: { items: Array<{ id: string }>; scale: { method: string } } };
    expect(json.sighting.items.map((item) => item.id)).toEqual(["usb1", "led1", "r1"]);
    expect(json.sighting.scale.method).toBe("known_part");
    expect(await Bun.file(join(project.dir, "photo/sighting.json")).exists()).toBe(true);
    expect(services.events.some((e) => e.topic === "photo.started")).toBe(true);
    expect(services.events.some((e) => e.topic === "photo.progress")).toBe(true);
  });

  test("photo_to_project drafts schematic, PCB, and publish meta that pass ERC/DRC", async () => {
    const project = await tempProject("photo-draft");
    const sketches = join(project.dir, "sketches");
    await mkdir(sketches, { recursive: true });
    await Bun.write(join(sketches, "front.png"), rectPng());
    const base = mockServices([project]);
    const services = mockServices([project], {
      vision: new FakeVisionProvider(items),
      design: base.design,
      kicad: base.kicad,
    });
    const factory = contextFactory(services, project);
    const reg = createRegistry();
    const call = (name: string, args: Record<string, unknown>) =>
      reg.invoke(name, args, (ref) =>
        factory({
          def: reg.get(name)!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      );
    await call("photo_analyze", { photos: ["sketches/front.png"], description: "LED badge" });
    const out = await call("photo_to_project", { acceptSighting: true, description: "LED badge" });
    expect(out.isError).toBeFalsy();
    expect(out.text).toContain("functional equivalent");
    expect(await Bun.file(join(project.dir, "circuit.netlist.json")).exists()).toBe(true);
    expect(await Bun.file(join(project.dir, "board.kicad_pcb")).exists()).toBe(true);
    expect(await Bun.file(join(project.dir, "board.kicad_sch")).exists()).toBe(true);
    expect(await Bun.file(join(project.dir, "photo/draft.json")).exists()).toBe(true);
    expect(await Bun.file(join(project.dir, "photo/publish.json")).exists()).toBe(true);
    const draft = JSON.parse(await Bun.file(join(project.dir, "photo/draft.json")).text()) as {
      erc: { errors: number };
      drc: { errors: number };
      route: { routed: number };
    };
    expect(draft.erc.errors).toBe(0);
    expect(draft.drc.errors).toBe(0);
    expect(draft.route.routed).toBeGreaterThan(0);
    expect(project.manifest().source?.kind).toBe("photo");
    expect(services.events.some((e) => e.topic === "photo.done")).toBe(true);
  });
});
