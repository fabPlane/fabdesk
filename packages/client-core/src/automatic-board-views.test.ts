import { expect, test } from "bun:test";
import { readBoardLayers, runPreviewTool } from "./automatic-board-views";
import type { CoreClient } from "./CoreClient";

test("saved layers are reused only for the exact saved PCB", async () => {
  const hash = "a".repeat(64), client = { readFile: async () => JSON.stringify({ version: 1, sourceSha256: hash, layers: [{ name: "F.Cu", svg: "<svg/>" }] }) };
  expect((await readBoardLayers(client, "p", "renders/board-layers.json", hash))?.layers).toHaveLength(1);
  expect(await readBoardLayers(client, "p", "renders/board-layers.json", "b".repeat(64))).toBeNull();
  expect(await readBoardLayers({ readFile: async () => "broken JSON" }, "p", "x", hash)).toBeNull();
});
test("a failed export surfaces its error instead of treating a queued job as a completed preview", async () => {
  const client = { callTool: async () => ({ jobId: "j" }), waitJob: async () => ({ status: "failed", error: "KiCad unavailable" }) } as unknown as Pick<CoreClient, "callTool" | "waitJob">;
  await expect(runPreviewTool(client, "render_glb", { projectId: "p" })).rejects.toThrow("KiCad unavailable");
});
