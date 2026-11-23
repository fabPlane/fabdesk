/** Embedded-footprint rotation and failure recovery must survive a native save/reopen. */
import { expect, test } from "bun:test";
import { SaveDocumentSchema } from "@fp-pcb/proto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFpPcbDesign } from "./fp-pcb-design";
import { FpPcbBridgeClient } from "./fp-pcb-bridge";
import { FpPcbSessions } from "./fp-pcb-session";

const url = process.env["FABDESK_FP_PCB_TEST_URL"];
const workspace = process.env["FABDESK_FP_PCB_TEST_WORKSPACE"];

test.skipIf(!url || !workspace)("embedded pads rotate without their source library and a failed save cannot leak into retry", async () => {
  const dir = await mkdtemp(join(workspace!, "embedded-placement-"));
  const bridge = new FpPcbBridgeClient({ url: url! });
  const sessions = new FpPcbSessions(() => bridge);
  const design = createFpPcbDesign({ bridge: () => bridge, sessions });
  try {
    await design.schematicEdit(dir, {
      symbols: ["J1", "J2"].map((reference, index) => ({
        reference, libId: "Connector_Generic:Conn_01x02", value: "probe",
        footprint: "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical",
        position: { x: 50.8 + 25.4 * index, y: 50.8 },
      })),
      connections: ["1", "2"].map(pin => ({ name: `PIN_${pin}`, nodes: ["J1", "J2"].map(reference => ({ reference, pin })) })),
    });
    expect(await design.syncSchematicToPcb(dir, false)).toMatchObject({ ok: true, saved: true, update: { newFootprints: 2 } });
    await sessions.release(dir);
    const path = join(dir, "board.kicad_pcb");
    const original = await readFile(path, "utf8");
    const unavailable = "UnavailableRegression:EmbeddedOnly";
    const embedded = original.replace(/\(footprint "[^"]+"/g, `(footprint "${unavailable}"`);
    expect(embedded).not.toBe(original);
    await writeFile(path, embedded);
    const before = (await (await sessions.board(dir)).getFootprints()).find(footprint => footprint.reference === "J1")!;
    expect(before.libraryId).toBe(unavailable);
    const pads = before.pads.map(pad => ({ number: pad.number, position: pad.position }));
    expect(pads).toHaveLength(2);
    expect(pads.some(pad => pad.position.x !== before.position.x || pad.position.y !== before.position.y)).toBe(true);

    const board = await sessions.board(dir), client = board.client, invoke = client.call.bind(client);
    let injected = false;
    client.call = (async (...args: any[]) => {
      const result = await (invoke as (...args: any[]) => Promise<unknown>)(...args);
      if (!injected && args[0].typeName === SaveDocumentSchema.typeName) {
        injected = true;
        throw new Error("injected save response failure");
      }
      return result;
    }) as typeof client.call;
    await expect(design.placeFootprints(dir, [{ reference: "J1", rotation: before.orientation + 180 }])).rejects.toThrow("injected save response failure");
    expect(injected).toBe(true);
    client.call = invoke;
    expect(await readFile(path, "utf8")).toBe(embedded);
    const recovered = (await (await sessions.board(dir)).getFootprints()).find(footprint => footprint.reference === "J1")!;
    expect(recovered.orientation).toBe(before.orientation);
    expect(recovered.pads.map(pad => ({ number: pad.number, position: pad.position }))).toEqual(pads);

    const placed = await design.placeFootprints(dir, [{ reference: "J1", rotation: before.orientation + 180 }]);
    expect(placed.moved).toEqual(["J1"]);
    expect(placed.libraryNormalized).toBe(0);
    await sessions.restart(dir);
    const after = (await (await sessions.board(dir)).getFootprints()).find(footprint => footprint.reference === "J1")!;
    expect(after.libraryId).toBe(unavailable);
    expect(Math.abs(after.orientation - before.orientation) % 360).toBe(180);
    for (const pad of pads) expect(after.padByNumber(pad.number)?.position).toEqual({
      x: 2 * before.position.x - pad.position.x,
      y: 2 * before.position.y - pad.position.y,
    });
  } finally {
    await sessions.dispose();
    if (process.env["FABDESK_KEEP_TEST_PROJECT"] !== "1") await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
