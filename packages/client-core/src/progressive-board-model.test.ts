import { expect, test } from "bun:test";
import type { CoreClient } from "./CoreClient";
import { CoreHttpError } from "./CoreClient";
import { sha256Blob } from "./pcb-preview-revision";
import { loadProgressiveBoardModel } from "./progressive-board-model";

test("a verified local preview is delivered before blocked downloads, and an offline reopening reads it directly", async () => {
  const source = new Blob(["board"]), hash = await sha256Blob(source);
  let model: Blob | undefined;
  let receipt: Record<string, unknown> | undefined;
  const save = async (bytes: string, pending: number) => {
    model = new Blob([bytes]);
    receipt = { contract: "fabplane.board-model-revision.v1", source: "board.kicad_pcb", artifact: "renders/board.glb",
      sourceSha256: hash, artifactSha256: await sha256Blob(model), generatedAt: new Date().toISOString(), dependencies: "unverified",
      ...(pending ? { pendingModels: pending } : {}) };
  };
  const client = {
    readFile: async () => { if (!receipt) throw new CoreHttpError(404, "receipt", "missing"); return JSON.stringify(receipt); },
    readFileBlob: async (_id: string, path: string) => path.endsWith(".glb") ? model! : source,
  } as unknown as CoreClient;
  let resume!: () => void, started!: () => void;
  const gate = new Promise<void>(r => { resume = r; }), enriching = new Promise<void>(r => { started = r; });
  const stages: string[] = [];
  const completed = loadProgressiveBoardModel(client, "p", hash, undefined, async options => {
    if (options.localModelsOnly) { stages.push("local export"); await save("local", 2); return; }
    expect(options.completeLocalPreview).toBe(String(receipt!.artifactSha256));
    stages.push("download"); started(); await gate; await save("assembled", 0);
  }, model => { expect(model.pendingModels).toBe(2); stages.push("visible"); }, () => true);
  await enriching;
  expect(stages).toEqual(["local export", "visible", "download"]);
  const offline = await loadProgressiveBoardModel(client, "p", hash, undefined, async () => { throw Error("unexpected export"); }, () => {}, () => false);
  expect(await offline.blob.text()).toBe("local");
  resume();
  expect(await (await completed).blob.text()).toBe("assembled");
  const warm = await loadProgressiveBoardModel(client, "p", hash, undefined, async () => { throw Error("unexpected export"); }, () => {}, () => false);
  expect(await warm.blob.text()).toBe("assembled");
});
