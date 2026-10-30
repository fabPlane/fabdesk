import { expect, test } from "bun:test";
import type { CoreClient } from "./CoreClient";
import { loadPcbDisplay } from "./pcb-display";

test("model requests deduplicate, refresh on demand and reject mismatched revisions", async () => {
  let calls = 0;
  const client = {
    baseUrl: "test-display",
    callTool: async (_name: string, args: Record<string, string>) => {
      calls++;
      return {
        result: {
          json: {
            modelPath: "renders/board.glb",
            pcbRevision: args.expectedPcbRevision,
            coverage: { loaded: 0, total: 0, missing: [] },
            warnings: [],
          },
        },
      };
    },
    readFileBlob: async () => new Blob(["model"]),
  } as unknown as CoreClient;
  const a = loadPcbDisplay(client, "p", "board.kicad_pcb", "r1");
  expect(loadPcbDisplay(client, "p", "board.kicad_pcb", "r1")).toBe(a);
  await a;
  await loadPcbDisplay(client, "p", "board.kicad_pcb", "r2");
  await loadPcbDisplay(client, "p", "board.kicad_pcb", "r2", true);
  expect(calls).toBe(3);
  client.callTool = async () =>
    ({ result: { json: { modelPath: "old.glb", pcbRevision: "old" } } }) as never;
  await expect(loadPcbDisplay(client, "p", "board.kicad_pcb", "r3")).rejects.toThrow(
    "does not match",
  );
});
