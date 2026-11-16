import { expect, test } from "bun:test";
import { BOARD_ARTWORK_PATH, type BoardArtworkSettings } from "@fabdesk/protocol";
import { CoreHttpError } from "./CoreClient";
import { createArtworkSessionStore, loadBoardArtwork, saveBoardArtwork } from "./board-artwork";

const settings = (): BoardArtworkSettings => ({ style: "retro", color: "green", crop: "none", outline: "rectangle", widthMm: 80, heightMm: 50, invert: false, threshold: .5, layers: ["silk"], placement: { centerXmm: 20, centerYmm: 25, widthMm: 10, heightMm: 15, rotationDeg: 30 }, lockProportions: true });
const view = { zoom: 1.5, placing: false };
function fixture() {
  const files = new Map<string, Blob>(), writes: string[] = [];
  const client = {
    async readFileBlob(projectId: string, path: string) { const blob = files.get(`${projectId}/${path}`); if (!blob) throw new CoreHttpError(404, path, "missing"); return blob; },
    async writeFile(projectId: string, path: string, content: Blob | string) { writes.push(`${projectId}/${path}`); files.set(`${projectId}/${path}`, typeof content === "string" ? new Blob([content]) : content); },
  };
  const args = { client, projectId: "one", image: new Blob(["original image bytes"]), name: "image.png", settings: settings(), view, expectedText: null };
  return { files, writes, client, args };
}

test("art sessions copy settings and separate endpoints, projects and unassigned drafts", () => {
  const sessions = createArtworkSessionStore(), image = new Blob(["pixels"]), draft = { image, name: "a.png", settings: settings(), view, baseText: null, savedImage: null, savedSettings: null };
  sessions.set("local-a", "one", draft); draft.settings.placement!.centerXmm = 999; draft.settings.layers.push("copper");
  expect(sessions.get("local-a", "one")?.settings.placement?.centerXmm).toBe(20);
  expect(sessions.get("local-a", "one")?.settings.layers).toEqual(["silk"]);
  const restored = sessions.get("local-a", "one")!; restored.settings.layers.push("mask");
  expect(sessions.get("local-a", "one")?.settings.layers).toEqual(["silk"]);
  expect(sessions.get("local-b", "one")).toBeNull(); expect(sessions.get("local-a", "two")).toBeNull(); expect(sessions.get("local-a", null)).toBeNull();
  sessions.set("local-a", null, { ...draft, name: "unassigned.png" });
  expect(sessions.get("local-a", "one")?.name).toBe("a.png");
});

test("saved artwork round-trips placement/view and writes no native circuit file", async () => {
  const f = fixture(); f.files.set("one/board.kicad_pcb", new Blob(["native copper retained"]));
  const saved = await saveBoardArtwork(f.args), loaded = await loadBoardArtwork(f.client, "one");
  expect(loaded?.record).toEqual(saved.record); expect(loaded?.record.settings.placement?.rotationDeg).toBe(30); expect(loaded?.record.view).toEqual(view);
  expect(await loaded?.image.text()).toBe("original image bytes"); expect(f.writes).toHaveLength(2);
  expect(f.writes.every(path => path.startsWith("one/artwork/"))).toBe(true); expect(await f.files.get("one/board.kicad_pcb")?.text()).toBe("native copper retained");
});

test("a save snapshots caller options before awaiting image hashing", async () => {
  const f = fixture(), saving = saveBoardArtwork(f.args); f.args.settings.layers.push("copper"); f.args.settings.placement!.rotationDeg = 180;
  const result = await saving; expect(result.record.settings.layers).toEqual(["silk"]); expect(result.record.settings.placement?.rotationDeg).toBe(30);
});

test("foreign owner metadata never opens its source image", async () => {
  const f = fixture(), saved = await saveBoardArtwork(f.args); f.files.set(`two/${BOARD_ARTWORK_PATH}`, new Blob([saved.text]));
  await expect(loadBoardArtwork(f.client, "two")).rejects.toThrow("another project");
});

test("modified image bytes are rejected on reopen", async () => {
  const f = fixture(), saved = await saveBoardArtwork(f.args); f.files.set(`one/${saved.record.source.path}`, new Blob(["unexpected replacement"]));
  await expect(loadBoardArtwork(f.client, "one")).rejects.toThrow("changed or is incomplete");
});

test("known changed metadata is not overwritten", async () => {
  const f = fixture(); f.files.set(`one/${BOARD_ARTWORK_PATH}`, new Blob(["changed elsewhere"]));
  await expect(saveBoardArtwork(f.args)).rejects.toThrow("changed elsewhere"); expect(f.writes).toEqual([]);
});

test("metadata changing during image upload survives the second source check", async () => {
  const f = fixture(), write = f.client.writeFile;
  f.client.writeFile = async (...args) => { await write(...args); f.files.set(`one/${BOARD_ARTWORK_PATH}`, new Blob(["concurrent art settings"])); };
  await expect(saveBoardArtwork(f.args)).rejects.toThrow("changed elsewhere");
  expect(f.writes).toHaveLength(1); expect(await f.files.get(`one/${BOARD_ARTWORK_PATH}`)?.text()).toBe("concurrent art settings");
});

test("failed metadata write leaves original image available for retry without claiming saved", async () => {
  const f = fixture(), write = f.client.writeFile;
  f.client.writeFile = async (...args) => { if (args[1] === BOARD_ARTWORK_PATH) throw new Error("disk unavailable"); await write(...args); };
  await expect(saveBoardArtwork(f.args)).rejects.toThrow("disk unavailable"); expect(f.writes).toHaveLength(1); expect(f.files.has(`one/${BOARD_ARTWORK_PATH}`)).toBe(false);
});

test("missing metadata is distinct from unavailable storage", async () => {
  const f = fixture(); expect(await loadBoardArtwork(f.client, "one")).toBeNull();
  f.client.readFileBlob = async () => { throw new CoreHttpError(503, BOARD_ARTWORK_PATH, "unavailable"); };
  await expect(loadBoardArtwork(f.client, "one")).rejects.toThrow();
});

test("unsafe paths and invalid dimensions are rejected before writing", async () => {
  const f = fixture(); f.args.settings.widthMm = NaN;
  await expect(saveBoardArtwork(f.args)).rejects.toThrow(); expect(f.writes).toEqual([]);
  f.args.settings = settings(); const saved = await saveBoardArtwork(f.args), changed = { ...saved.record, source: { ...saved.record.source, path: "../board.kicad_pcb" } };
  f.files.set(`one/${BOARD_ARTWORK_PATH}`, new Blob([JSON.stringify(changed)])); await expect(loadBoardArtwork(f.client, "one")).rejects.toThrow();
});

test("saved artwork retains incoming color settings alongside guarded placement and view", async () => {
  const f = fixture();
  Object.assign(f.args.settings, { colorMode: "multicolor", printedBackground: "#abcdef", inkColor: "#123456", recolor: { mode: "duotone", amount: .65, shadow: "#123456", highlight: "#abcdef" } });
  await saveBoardArtwork(f.args);
  const loaded = await loadBoardArtwork(f.client, "one");
  expect(loaded?.record.settings).toEqual(f.args.settings);
  expect(loaded?.record.view).toEqual(view);
  expect(f.writes.every(path => path.startsWith("one/artwork/"))).toBe(true);
});
