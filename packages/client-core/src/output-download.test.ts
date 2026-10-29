import { expect, test } from "bun:test";
import { readOutputSelection, OUTPUT_DOWNLOAD_LIMIT } from "./output-download";

test("batch output download keeps duplicate basenames board-qualified and deduplicates exact paths", async () => {
  const requested: string[] = [];
  const client = { readFileBlob: async (_id: string, path: string) => { requested.push(path); return new Blob([path]); } };
  const entries = await readOutputSelection(client, "project", [{ path: "boards/io/renders/pcb.svg", size: 30 }, { path: "boards/lcd/renders/pcb.svg", size: 30 }, { path: "boards/io/renders/pcb.svg", size: 30 }]);
  expect(entries.map(entry => entry.name)).toEqual(requested);
  expect(entries).toHaveLength(2);
  expect(new TextDecoder().decode(entries[1]!.data)).toBe("boards/lcd/renders/pcb.svg");
});

test("unsafe archive names and oversized selections are refused before any reads", async () => {
  let reads = 0;
  const client = { readFileBlob: async () => { reads++; return new Blob(["x"]); } };
  for (const path of ["../private", "exports/../board.kicad_pcb", "/tmp/test", "a\\b", "a:b"])
    await expect(readOutputSelection(client, "project", [{ path, size: 1 }])).rejects.toThrow(/invalid project path/);
  await expect(readOutputSelection(client, "project", [{ path: "renders/large.glb", size: OUTPUT_DOWNLOAD_LIMIT + 1 }])).rejects.toThrow(/too large/);
  expect(reads).toBe(0);
});

test("a failed file prevents a partial successful batch result", async () => {
  const client = { readFileBlob: async (_id: string, path: string) => { if (path.endsWith("missing.svg")) throw new Error("Output missing"); return new Blob(["saved"]); } };
  await expect(readOutputSelection(client, "project", [{ path: "renders/top.svg", size: 5 }, { path: "renders/missing.svg", size: 5 }])).rejects.toThrow("Output missing");
});
