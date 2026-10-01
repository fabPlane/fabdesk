/**
 * The `CadService` end to end against the real `@fab-cad/bridge`, with fab_cad's mock FreeCAD API
 * server standing in for `FreeCADApiServer` (the same way fab_cad's own bridge tests run).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startBridge, type BridgeServer } from "@fab-cad/bridge";
import { ToolError } from "@fabdesk/tools";
import { createFabCad } from "../src/fab-cad";
import { FabCadBridgeClient } from "../src/fab-cad-bridge";

const MOCK = resolve(import.meta.dir, "../../../vendor/fab_cad/packages/mock-server/src/main.ts");

let root: string;
let project: string;
let bridge: BridgeServer;
let client: FabCadBridgeClient;
const services: Array<{ dispose(): Promise<void> }> = [];

function service() {
  const cad = createFabCad({ bridge: () => client, clientName: "fabdesk/test" });
  services.push(cad);
  return cad;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fabdesk-cad-"));
  project = join(root, "enclosure");
  await mkdir(project);
  bridge = await startBridge({
    port: 0,
    hostname: "127.0.0.1",
    serverCommand: [process.execPath, MOCK],
    serverArgs: ["--empty"],
    useKey: true,
    workspaceRoot: root,
    staticDir: null,
    startTimeoutMs: 20_000,
    killGraceMs: 1_000,
    maxPayloadBytes: 64 * 1024 * 1024,
    log: () => {},
  });
  client = new FabCadBridgeClient({ url: bridge.url });
});

afterAll(async () => {
  for (const s of services) await s.dispose();
  await bridge.stop();
  await rm(root, { recursive: true, force: true });
});

describe("CadService over the fab_cad bridge", () => {
  test("status reports the bridge and its FreeCAD", async () => {
    const status = await service().status();
    expect(status.reachable).toBe(true);
    expect(status.freecad).toContain(MOCK);
    expect(status.ui).toBe(false);
  });

  test("creates model.FCStd on first use, edits, recomputes, saves and exports", async () => {
    const cad = service();
    const empty = await cad.model(project);
    expect(empty.objects).toEqual([]);
    expect(empty.path).toBe(join(project, "model.FCStd"));
    expect(existsSync(empty.path)).toBe(true);

    const box = await cad.addObject(project, {
      type: "Part::Box",
      name: "Lid",
      properties: { Length: "40 mm", Width: 30, Height: "2 mm" },
    });
    expect(box.name).toBe("Lid");
    await cad.setExpression(project, "Lid", "Width", "Lid.Length * 0.5");
    expect((await cad.recompute(project)).errors).toEqual([]);
    await cad.save(project);

    const props = await cad.properties(project, "Lid", ["Length", "Width"]);
    const width = props.find((p) => p.name === "Width");
    expect(width?.expression).toBe("Lid.Length * 0.5");

    const model = await cad.model(project);
    expect(model.objects.map((o) => o.name)).toEqual(["Lid"]);
    expect(model.objects[0]!.bbox?.max[0]).toBeCloseTo(40);
    expect(model.undo.length).toBeGreaterThan(0);

    const stl = await cad.export(project, { format: "stl" });
    expect(stl.objects).toEqual(["Lid"]);
    expect(stl.data.byteLength).toBeGreaterThan(84);

    const view = await cad.view(project);
    expect(view.wsUrl).toBe(client.wsUrl(view.session));
    expect(view.uiUrl).toBeNull();
  });

  test("a new daemon adopts the session holding the model instead of starting another", async () => {
    const before = await client.sessions();
    const cad = service();
    const model = await cad.model(project);
    expect(model.objects.map((o) => o.name)).toEqual(["Lid"]);
    expect((await client.sessions()).length).toBe(before.length);
  });

  test("reconnects when the bridge lost the session, reopening the saved model", async () => {
    const cad = service();
    const { session } = await cad.view(project);
    await client.deleteSession(session);
    const model = await cad.model(project);
    expect(model.objects.map((o) => o.name)).toEqual(["Lid"]);
    const now = await client.sessions();
    expect(now.some((s) => s.path === join(project, "model.FCStd"))).toBe(true);
  });

  test("view never hands out a session the bridge no longer has", async () => {
    const cad = service();
    const first = await cad.view(project);
    await client.deleteSession(first.session);
    const second = await cad.view(project);
    expect(second.session).not.toBe(first.session);
    expect((await client.sessions()).some((s) => s.id === second.session)).toBe(true);
  });

  test("FreeCAD refusals become tool errors the agent can act on", async () => {
    const cad = service();
    const err = await cad.properties(project, "Nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe("not_found");
  });

  test("release stops the project's FreeCAD", async () => {
    const cad = service();
    const { session } = await cad.view(project);
    await cad.release(project);
    expect((await client.sessions()).some((s) => s.id === session)).toBe(false);
  });

  test("an unreachable bridge is reported, not thrown", async () => {
    const cad = createFabCad({
      bridge: () => new FabCadBridgeClient({ url: "http://127.0.0.1:9", timeoutMs: 500 }),
    });
    const status = await cad.status();
    expect(status.reachable).toBe(false);
    await expect(cad.model(project)).rejects.toMatchObject({ code: "unavailable" });
  });
});
