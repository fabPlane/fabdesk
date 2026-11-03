import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGlbContainer } from "../src/glb-container";
import { exportGlb } from "../src/render";
import { measureGlb } from "../src/mechanical";
import type { KicadCli } from "../src/cli";

function model(
  document: unknown = {
    asset: { version: "2.0" },
    scenes: [{ nodes: [] }],
    buffers: [{ byteLength: 4 }],
  },
) {
  let json = JSON.stringify(document);
  while (json.length % 4) json += " ";
  const bytes = Buffer.alloc(28 + json.length + 4);
  bytes.writeUInt32LE(0x46546c67, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json.length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.write(json, 20);
  bytes.writeUInt32LE(4, 20 + json.length);
  bytes.writeUInt32LE(0x004e4942, 24 + json.length);
  return bytes;
}

test("GLB framing rejects partial, appended and invalid native data before geometry is read", () => {
  const good = model();
  expect(parseGlbContainer(good).binLength).toBe(4);
  const padded = Buffer.concat([Buffer.alloc(11), good, Buffer.alloc(7)]);
  expect(parseGlbContainer(padded.subarray(11, -7)).binLength).toBe(4);
  expect(() => parseGlbContainer(Buffer.concat([good, Buffer.alloc(4)]))).toThrow("file length");
  expect(() => parseGlbContainer(good.subarray(0, -4))).toThrow("file length");
  const truncated = Buffer.from(good.subarray(0, -4));
  truncated.writeUInt32LE(truncated.length, 8);
  expect(() => parseGlbContainer(truncated)).toThrow("chunk length");
  const badJson = Buffer.from(good);
  badJson[20] = 0;
  expect(() => parseGlbContainer(badJson)).toThrow();
  const wrong = Buffer.from(good);
  wrong[0] = 0;
  expect(() => parseGlbContainer(wrong)).toThrow("not a binary");
});

test("GLB framing preserves permitted unknown extension chunks", () => {
  const good = model();
  const extended = Buffer.concat([good, Buffer.alloc(12)]);
  extended.writeUInt32LE(extended.length, 8);
  extended.writeUInt32LE(4, good.length);
  extended.writeUInt32LE(0x12345678, good.length + 4);
  expect(parseGlbContainer(extended).binLength).toBe(4);
});

test("geometry accessors cannot read unknown chunks as vertex coordinates", () => {
  const good = model({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "part", mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: "VEC3" }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
    buffers: [{ byteLength: 4 }],
  });
  const extended = Buffer.concat([good, Buffer.alloc(12)]);
  extended.writeUInt32LE(extended.length, 8);
  extended.writeUInt32LE(4, good.length);
  extended.writeUInt32LE(0x12345678, good.length + 4);
  expect(() => measureGlb(extended)).toThrow("accessor exceeds buffer");
});

const temporary: string[] = [];
afterEach(async () => {
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function destination() {
  const dir = await mkdtemp(join(tmpdir(), "fabdesk-glb-integrity-"));
  temporary.push(dir);
  return { dir, output: join(dir, "board.glb"), board: join(dir, "board.kicad_pcb") };
}

test("an incomplete successful-process export retries once and publishes only valid bytes", async () => {
  const { dir, output, board } = await destination();
  const good = model(),
    calls: string[][] = [];
  const previous = model({
    asset: { version: "2.0", generator: "previous" },
    scenes: [{ nodes: [] }],
  });
  await writeFile(output, previous);
  const cli: KicadCli = {
    path: "unused",
    version: "test",
    trace: async ({ command }) => {
      calls.push(command);
      expect(await readFile(output)).toEqual(previous);
      await writeFile(
        command[command.indexOf("-o") + 1]!,
        calls.length === 1 ? good.subarray(0, 24) : good,
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const result = await exportGlb(cli, { board, output });
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain("--fuse-shapes");
  expect(calls[1]).not.toContain("--fuse-shapes");
  expect(result.fused).toBe(false);
  expect(result.warnings).toContain("The first 3D export was incomplete; a fresh retry succeeded.");
  expect(await readFile(output)).toEqual(good);
  expect(await readdir(dir)).toEqual(["board.glb"]);
});

test("failed native retries preserve an earlier export and remove all temporary files", async () => {
  const { dir, output, board } = await destination();
  const good = model();
  await writeFile(output, good);
  let attempts = 0;
  const cli: KicadCli = {
    path: "unused",
    version: "test",
    trace: async ({ command }) => {
      attempts++;
      await writeFile(command[command.indexOf("-o") + 1]!, "not a model");
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  await expect(exportGlb(cli, { board, output, mechanical: true })).rejects.toThrow("not a binary");
  expect(attempts).toBe(2);
  expect(await readFile(output)).toEqual(good);
  expect(await readdir(dir)).toEqual(["board.glb"]);
});

test("cancelled exports do not retry or replace an earlier valid model", async () => {
  const { dir, output, board } = await destination();
  const good = model(),
    abort = new AbortController();
  await writeFile(output, good);
  let attempts = 0;
  const cli: KicadCli = {
    path: "unused",
    version: "test",
    trace: async ({ command }) => {
      attempts++;
      await writeFile(command[command.indexOf("-o") + 1]!, good);
      abort.abort(new Error("cancelled"));
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  await expect(exportGlb(cli, { board, output, signal: abort.signal })).rejects.toThrow(
    "cancelled",
  );
  expect(attempts).toBe(1);
  expect(await readFile(output)).toEqual(good);
  expect(await readdir(dir)).toEqual(["board.glb"]);
});

test("a valid partial-model export remains usable despite KiCad's nonzero exit", async () => {
  const { output, board } = await destination();
  let attempts = 0;
  const cli: KicadCli = {
    path: "unused",
    version: "test",
    trace: async ({ command }) => {
      attempts++;
      await writeFile(command[command.indexOf("-o") + 1]!, model());
      return { exitCode: 5, stdout: "", stderr: "Could not add 3D model for J1." };
    },
  };
  const result = await exportGlb(cli, { board, output, mechanical: true });
  expect(attempts).toBe(1);
  expect(result.warnings).toContain("Could not add 3D model for J1.");
});
