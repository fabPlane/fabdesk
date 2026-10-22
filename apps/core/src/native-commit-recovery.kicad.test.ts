import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { CommitDroppedError } from "@fp-pcb/client";
import { CommitAction, EndCommitSchema } from "@fp-pcb/proto";
import { createFpPcbDesign } from "./fp-pcb-design";
import { FpPcbBridgeClient } from "./fp-pcb-bridge";
import { FpPcbSessions } from "./fp-pcb-session";

const url = process.env["FABDESK_FP_PCB_TEST_URL"],
  workspace = process.env["FABDESK_FP_PCB_TEST_WORKSPACE"];
test.skipIf(!url || !workspace)(
  "native finalization error restores the live circuit and preserves pre-existing unsaved work",
  async () => {
    const dir = await mkdtemp(join(workspace!, "commit-recovery-"));
    const bridge = new FpPcbBridgeClient({ url: url! }),
      sessions = new FpPcbSessions(() => bridge);
    const design = createFpPcbDesign({ bridge: () => bridge, sessions });
    try {
      await design.schematicEdit(dir, {
        symbols: [
          { reference: "R1", libId: "Device:R", value: "10k", position: { x: 50.8, y: 50.8 } },
        ],
      });
      const path = join(dir, "board.kicad_sch"),
        disk = await readFile(path);
      await design.schematicEdit(dir, {
        texts: [{ text: "Pre-existing unsaved note", position: { x: 25.4, y: 25.4 } }],
        save: false,
      });
      const { schematic } = await sessions.ensureProject(dir);
      const beforeNetlist = await schematic.netlist(),
        root = await schematic.rootSheet();
      const client = schematic.client,
        invoke = client.call.bind(client);
      let injected = false;
      client.call = (async (...args: any[]) => {
        const result = await (invoke as (...args: any[]) => Promise<unknown>)(...args);
        if (
          !injected &&
          args[0].typeName === EndCommitSchema.typeName &&
          args[1].action === CommitAction.CMA_COMMIT
        ) {
          injected = true;
          throw new Error("forced EndCommit response failure after native finalization");
        }
        return result;
      }) as typeof client.call;
      let error: unknown;
      try {
        await design.schematicEdit(dir, {
          symbolUpdates: [{ reference: "R1", position: { x: 76.2, y: 76.2 } }],
        });
      } catch (e) {
        error = e;
      }
      client.call = invoke;
      expect(injected).toBe(true);
      expect(error).toBeInstanceOf(CommitDroppedError);
      expect((error as Error).message).toContain("Prior live state restored");
      expect(await schematic.netlist()).toEqual(beforeNetlist);
      expect((await design.schematicInspect(dir)).symbols[0]?.position).toEqual({
        x: 50.8,
        y: 50.8,
      });
      expect(
        (await root.getAllItems()).some(
          (item) => "text" in item && item.text === "Pre-existing unsaved note",
        ),
      ).toBe(true);
      expect(await schematic.modified()).toBe(true);
      expect(await readFile(path)).toEqual(disk);
    } finally {
      await sessions.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  120000,
);
