import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { validateCadArchive } from "./cad-runtime-archive";
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
function zip(
  entries: { name: string; text?: string; mode?: number; localName?: string }[],
): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name),
      localName = Buffer.from(e.localName ?? e.name),
      data = Buffer.from(e.text ?? "data");
    const body = e.compressed ? deflateRawSync(data) : data;
    const length = e.declaredSize ?? data.length;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(e.compressed ? 8 : 0, 8);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(length, 22);
    h.writeUInt16LE(localName.length, 26);
    local.push(h, localName, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(0x0314, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(e.compressed ? 8 : 0, 10);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((e.mode ?? 0x81a4) << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += h.length + localName.length + body.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
async function check(entries: Parameters<typeof zip>[0], limit = 10000) {
  const dir = await mkdtemp(join(tmpdir(), "cad-zip-test-"));
  dirs.push(dir);
  const path = join(dir, "runtime.zip");
  await writeFile(path, zip(entries));
  return validateCadArchive(path, limit);
}
test("accepts regular payload and internal framework aliases", async () => {
  await check([
    { name: "CADRuntime.app/Contents/file" },
    { name: "CADRuntime.app/Contents/Frameworks/A/Versions/Current", mode: 0xa1ff, text: "3.12" },
    { name: "CADRuntime.app/Contents/Frameworks/A/Versions/3.12/file" },
  ]);
});
test("rejects path traversal, external/special files, aliases with children and case collisions", async () => {
  for (const entries of [
    [{ name: "../evil" }],
    [{ name: "/CADRuntime.app/evil" }],
    [{ name: "CADRuntime.app/../evil" }],
    [{ name: "CADRuntime.app/x", mode: 0xa1ff, text: "../../evil" }],
    [{ name: "CADRuntime.app/x", mode: 0xa1ff, text: "/tmp/evil" }],
    [{ name: "CADRuntime.app/x", mode: 0x21ff }],
    [{ name: "CADRuntime.app/X" }, { name: "CADRuntime.app/x" }],
    [
      { name: "CADRuntime.app/link", mode: 0xa1ff, text: "target" },
      { name: "CADRuntime.app/link/file" },
    ],
    [{ name: "CADRuntime.app/file", localName: "CADRuntime.app/evil" }],
  ])
    await expect(check(entries)).rejects.toThrow();
});
test("rejects a decompression-size overrun before extraction", async () => {
  await expect(check([{ name: "CADRuntime.app/file", text: "123456" }], 5)).rejects.toThrow(/size/);
});

test("verifies actual deflated lengths and rejects a forged directory size", async () => {
  await check([{ name: "CADRuntime.app/file", compressed: true, text: "x".repeat(1000) }]);
  await expect(
    check([
      { name: "CADRuntime.app/file", compressed: true, text: "x".repeat(1000), declaredSize: 1 },
    ]),
  ).rejects.toThrow(/size/);
});
