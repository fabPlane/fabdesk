import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, stat, utimes, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileEntry } from "@fabdesk/protocol";
import { OutputGenerationTimes } from "../src/output-generation-times";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const date = "2026-11-02T03:00:00.000Z";
const receipt = (artifact: string, bytes: string) => ({ contract: "fabplane.output-revision.v1", projectId: "p", artifact, artifactSha256: hash(bytes), generatedAt: date, basis: "pcb", inputs: [{ path: "board.kicad_pcb", sha256: hash("pcb") }], dependencies: "unverified" });
async function fixture(run: (f: { dir: string; put: (path: string, bytes: string) => Promise<void>; inspect: () => Promise<FileEntry[]> }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "fabdesk-output-time-")), entries = new Set<string>(), times = new OutputGenerationTimes();
  const put = async (path: string, bytes: string) => { await mkdir(join(dir, path, ".."), { recursive: true }); await writeFile(join(dir, path), bytes); entries.add(path); };
  const inspect = async () => times.attach(dir, "p", await Promise.all([...entries].map(async path => { const info = await stat(join(dir, path)); return { path, size: info.size, mtime: info.mtime.toISOString() }; })));
  try { await run({ dir, put, inspect }); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("matching bytes retain export time after touch, then changed bytes invalidate cached time", async () => fixture(async ({ dir, put, inspect }) => {
  await put("renders/top.png", "image"); await put("renders/top.png.revision.json", JSON.stringify(receipt("renders/top.png", "image")));
  expect((await inspect())[0]?.generatedAt).toBe(date);
  await utimes(join(dir, "renders/top.png"), new Date(), new Date("2027-01-01"));
  expect((await inspect())[0]?.generatedAt).toBe(date);
  await put("renders/top.png", "changed");
  expect((await inspect())[0]?.generatedAt).toBeUndefined();
}));

test("member receipts attach only to their own exact file and project", async () => fixture(async ({ put, inspect }) => {
  await put("boards/renders/io/renders/top.png", "io"); await put("renders/top.png", "root");
  await put("boards/renders/io/renders/top.png.revision.json", JSON.stringify({ ...receipt("renders/top.png", "io"), board: { sourceId: "io", manifestSha256: hash("manifest") } }));
  await put("renders/top.png.revision.json", JSON.stringify({ ...receipt("renders/top.png", "root"), projectId: "other" }));
  const files = await inspect();
  expect(files.find(file => file.path === "boards/renders/io/renders/top.png")?.generatedAt).toBe(date);
  expect(files.find(file => file.path === "renders/top.png")?.generatedAt).toBeUndefined();
  await put("boards/renders/io/renders/top.png.revision.json", JSON.stringify(receipt("renders/bottom.png", "io")));
  expect((await inspect()).find(file => file.path === "boards/renders/io/renders/top.png")?.generatedAt).toBeUndefined();
}));

test("video time requires a completed timestamp, valid output hash and nonempty file", async () => fixture(async ({ put, inspect }) => {
  await put("exports/product-video.mp4", "video"); await put("exports/product-video.webm", "");
  const video = { generatedAt: date, revision: { contract: "fabplane.video-input-revision.v1", inputs: [{ path: "renders/board.glb", sha256: hash("mesh") }], outputs: [{ path: "exports/product-video.mp4", sha256: hash("video") }, { path: "exports/product-video.webm", sha256: hash("") }] } };
  await put("exports/product-video.json", JSON.stringify(video));
  expect((await inspect()).find(file => file.path.endsWith(".mp4"))?.generatedAt).toBe(date);
  expect((await inspect()).find(file => file.path.endsWith(".webm"))?.generatedAt).toBeUndefined();
  await put("exports/product-video.json", JSON.stringify({ revision: video.revision }));
  expect((await inspect()).find(file => file.path.endsWith(".mp4"))?.generatedAt).toBeUndefined();
}));

test("PCB/model/schematic receipts preserve actual artifact identity", async () => fixture(async ({ put, inspect }) => {
  for (const [artifact, contract] of [["renders/pcb.svg", "fabplane.pcb-preview-revision.v1"], ["renders/board.glb", "fabplane.board-model-revision.v1"]]) {
    await put(artifact!, artifact!);
    await put(artifact + ".revision.json", JSON.stringify({ contract, source: "board.kicad_pcb", artifact, sourceSha256: hash("pcb"), artifactSha256: hash(artifact!), generatedAt: date, dependencies: "unverified" }));
  }
  await put("boards/io/renders/schematic/rev/sheet.svg", "svg");
  await put("boards/io/renders/schematic.revision.json", JSON.stringify({ contract: "fabplane.schematic-preview-revision.v1", boardSource: { projectId: "p", sourceId: "io", manifestSha256: hash("manifest") }, sourceRevision: hash("sch"), sourceFiles: [{ path: "board.kicad_sch", sha256: hash("sch") }], sheets: [{ path: "renders/schematic/rev/sheet.svg", name: "Root", sha256: hash("svg") }], generatedAt: date, dependencies: "unverified" }));
  expect((await inspect()).filter(file => file.generatedAt).map(file => file.path)).toEqual(["renders/pcb.svg", "renders/board.glb", "boards/io/renders/schematic/rev/sheet.svg"]);
}));

test("malformed receipts and symlink targets outside the project fall back without reading outside", async () => fixture(async ({ dir, put, inspect }) => {
  await put("renders/top.png", "image"); await put("renders/top.png.revision.json", "{invalid");
  expect((await inspect())[0]?.generatedAt).toBeUndefined();
  await put("renders/top.png.revision.json", JSON.stringify(receipt("renders/top.png", "image")));
  await rm(join(dir, "renders/top.png")); await symlink(join(dir, ".."), join(dir, "renders/top.png"));
  expect((await inspect())[0]?.generatedAt).toBeUndefined();
}));
