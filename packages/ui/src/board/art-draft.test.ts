import { expect, test } from "bun:test";
import { CoreClient } from "@fabdesk/client-core";
import {
  ART_DRAFT_PATH,
  artDraftStore,
  base64ToBytes,
  bytesToBase64,
  parseArtDraft,
  type ArtDraft,
} from "./art-draft";

const draft: ArtDraft = {
  version: 1,
  view: { zoom: 2, placing: false },
  lockProportions: false,
  source: bytesToBase64(new Uint8Array([0, 10, 255, 128])),
  sourceName: "source.png",
  options: {
    colorMode: "multicolor",
    printedBackground: "#abcdef",
    inkColor: "#654321",
    color: "red",
    style: "realistic",
    outline: "rounded",
    widthMm: 80,
    heightMm: 50,
    crop: "circle",
    placement: { centerXmm: 42, centerYmm: 22, widthMm: 30, heightMm: 30, rotationDeg: 15 },
  },
};

test("project drafts retain original image bytes, mode, colors and placement after a new client opens them", async () => {
  const files = new Map<string, string>();
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const key = String(input);
    if (init?.method === "PUT") {
      files.set(key, String(init.body));
      return new Response("ok");
    }
    return new Response(files.get(key) ?? "not found", { status: files.has(key) ? 200 : 404 });
  };
  const client = new CoreClient({ baseUrl: "http://isolated-test", token: "test", fetch });
  const first = artDraftStore(client, "art-first");
  expect(await first.load()).toBeNull();
  first.stage(draft);
  await first.save();
  const second = artDraftStore(client, "circuit-first");
  expect(await second.load()).toBeNull();
  second.stage({
    ...draft,
    sourceName: "different.png",
    options: { ...draft.options, printedBackground: "#123456" },
  });
  await second.save();
  const reopened = new CoreClient({ baseUrl: "http://isolated-test", token: "test", fetch });
  const restored = await artDraftStore(reopened, "art-first").load();
  expect(restored).toEqual(draft);
  expect(base64ToBytes(restored!.source!)).toEqual(new Uint8Array([0, 10, 255, 128]));
  expect((await artDraftStore(reopened, "circuit-first").load())?.sourceName).toBe("different.png");
  expect([...files.keys()].every((key) => key.endsWith(ART_DRAFT_PATH))).toBe(true);
  expect([...files.keys()].some((key) => key.includes("board.kicad_pcb"))).toBe(false);
});

test("a corrupt or newer draft fails visibly instead of being mistaken for an empty draft", () => {
  expect(() => parseArtDraft(JSON.stringify({ ...draft, version: 2 }))).toThrow("Unsupported");
  expect(() =>
    parseArtDraft(
      JSON.stringify({ ...draft, options: { ...draft.options, printedBackground: "<script>" } }),
    ),
  ).toThrow("six-digit hex");
});

test("failed draft writes retain the newest edits and a retry persists them across reopening", async () => {
  const files = new Map<string, string>();
  let failWrites = false;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const key = String(input);
    if (init?.method === "PUT") {
      if (failWrites) return new Response("Draft storage unavailable", { status: 503 });
      files.set(key, String(init.body));
      return new Response("ok");
    }
    return new Response(files.get(key) ?? "not found", { status: files.has(key) ? 200 : 404 });
  };
  const client = new CoreClient({ baseUrl: "http://draft-retry-test", token: "test", fetch });
  const store = artDraftStore(client, "art-first");
  store.stage(draft);
  await store.save();
  failWrites = true;
  const changed = { ...draft, view: { zoom: 1.25, placing: false } };
  store.stage(changed);
  await expect(store.save()).rejects.toThrow();
  const latest = { ...changed, options: { ...changed.options, widthMm: 100 } };
  store.stage(latest);
  await expect(store.save()).rejects.toThrow();
  expect(await store.load()).toEqual(latest);
  const reopened = () => artDraftStore(new CoreClient({ baseUrl: client.baseUrl, token: "test", fetch }), "art-first").load();
  expect(await reopened()).toEqual(draft);
  failWrites = false;
  await store.save();
  expect(await reopened()).toEqual(latest);
  expect([...files.keys()].every(key => key.endsWith(ART_DRAFT_PATH))).toBe(true);
});

test("legacy artwork drafts load while invalid view settings fail visibly", () => {
  const { view, lockProportions, ...legacy } = draft;
  expect(parseArtDraft(JSON.stringify(legacy))).toEqual(legacy);
  expect(() => parseArtDraft(JSON.stringify({ ...draft, view: { zoom: -1, placing: true } }))).toThrow();
  expect(() => parseArtDraft(JSON.stringify({ ...draft, lockProportions: "false" }))).toThrow();
});
