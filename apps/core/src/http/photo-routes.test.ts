import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod/v4";
import { encodePng } from "@fabdesk/board-art";
import { createRegistry } from "@fabdesk/tools";
import { photoRoutes } from "./photo-routes";
import { contextFactory, mockServices, tempProject } from "../../../../packages/tools/test/mock-services";

function rectPng(width = 40, height = 24): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const board = x > 3 && x < width - 3 && y > 3 && y < height - 3;
      const i = (y * width + x) * 4;
      const v = board ? 16 : 250;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return encodePng({ width, height, data });
}

const items = [
  {
    id: "usb1",
    kind: "connector",
    label: "USB-C",
    side: "front",
    box: { x: 0.1, y: 0.4, w: 0.15, h: 0.2 },
    confidence: 0.9,
  },
  {
    id: "led1",
    kind: "led",
    label: "LED",
    side: "front",
    box: { x: 0.5, y: 0.4, w: 0.1, h: 0.1 },
    confidence: 0.8,
  },
];

function appWithPhoto(project: Awaited<ReturnType<typeof tempProject>>) {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: z.prettifyError(err), code: "invalid_args" }, 400);
    throw err;
  });
  const base = mockServices([project]);
  const services = mockServices([project], { design: base.design, kicad: base.kicad });
  const registry = createRegistry();
  const ctxFactory = contextFactory(services, project);
  photoRoutes(app, {
    projects: {
      handle: async (id: string) => (id === project.id ? project : null),
    } as never,
    store: { projects: { touch() {} } },
    registry,
    ctxFactory,
  });
  return app;
}

describe("photo routes", () => {
  test("empty photo state, then 404 for unknown project", async () => {
    const project = await tempProject("http-photo-empty");
    const app = appWithPhoto(project);
    const empty = await app.request(`http://127.0.0.1/projects/${project.id}/photo`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ session: null, sighting: null, intent: null, draft: null });

    const missing = await app.request("http://127.0.0.1/projects/nope/photo");
    expect(missing.status).toBe(404);
  });

  test("analyze then continue drafts a project from a photo", async () => {
    const project = await tempProject("http-photo");
    const sketches = join(project.dir, "sketches");
    await mkdir(sketches, { recursive: true });
    await Bun.write(join(sketches, "front.png"), rectPng());
    const app = appWithPhoto(project);

    const analyzed = await app.request(`http://127.0.0.1/projects/${project.id}/photo/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        photos: ["sketches/front.png"],
        description: "USB LED badge",
        items,
      }),
    });
    expect(analyzed.status).toBe(200);
    const analyzedJson = (await analyzed.json()) as { sighting: { items: Array<{ id: string }> } };
    expect(analyzedJson.sighting.items.map((item) => item.id)).toEqual(["usb1", "led1"]);

    const continued = await app.request(`http://127.0.0.1/projects/${project.id}/photo/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acceptSighting: true, description: "USB LED badge" }),
    });
    expect(continued.status).toBe(200);

    const state = (await (
      await app.request(`http://127.0.0.1/projects/${project.id}/photo`)
    ).json()) as {
      session: { status: string };
      draft: { erc: { errors: number }; drc: { errors: number } };
    };
    expect(state.session.status).toBe("completed");
    expect(state.draft.erc.errors).toBe(0);
    expect(state.draft.drc.errors).toBe(0);
    expect(await Bun.file(join(project.dir, "board.kicad_pcb")).exists()).toBe(true);
    expect(await Bun.file(join(project.dir, "board.kicad_sch")).exists()).toBe(true);
    expect(project.manifest().source?.kind).toBe("photo");
  });

  test("PUT sighting stores a corrected what-I-see list", async () => {
    const project = await tempProject("http-photo-sighting");
    const app = appWithPhoto(project);
    const sighting = {
      schema: 1,
      photos: [{ path: "sketches/front.png", side: "front", widthPx: 200, heightPx: 120 }],
      items,
      outline: {
        source: "user",
        polygon: [
          { x: 0, y: 0 },
          { x: 40, y: 0 },
          { x: 40, y: 20 },
          { x: 0, y: 20 },
        ],
      },
      scale: {
        method: "user_dimension",
        boardWidthMm: 40,
        boardHeightMm: 20,
        assumedMmPerPx: 1,
        note: "User width",
        confidence: 0.9,
      },
      mountingHoles: [],
      notes: [],
      equivalentDisclaimer: "Functional equivalent.",
    };
    const saved = await app.request(`http://127.0.0.1/projects/${project.id}/photo/sighting`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sighting),
    });
    expect(saved.status).toBe(200);
    const state = (await (await app.request(`http://127.0.0.1/projects/${project.id}/photo`)).json()) as {
      sighting: { items: Array<{ id: string }> };
    };
    expect(state.sighting.items.map((item) => item.id)).toEqual(["usb1", "led1"]);
  });
});
