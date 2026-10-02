/** Preflight ZIPs before ditto sees any path. No ZIP64, encryption, special files or escaping links. */
import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, inflateRawSync } from "node:zlib";
export async function validateCadArchive(path: string, limit: number): Promise<void> {
  const f = await open(path, "r");
  try {
    const size = (await f.stat()).size;
    const tail = Buffer.alloc(Math.min(size, 65557));
    await f.read(tail, 0, tail.length, size - tail.length);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (
        tail.readUInt32LE(i) === 0x06054b50 &&
        i + 22 + tail.readUInt16LE(i + 20) === tail.length
      ) {
        end = i;
        break;
      }
    }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6))
      throw new Error("Unsupported runtime ZIP");
    const count = tail.readUInt16LE(end + 10),
      bytes = tail.readUInt32LE(end + 12),
      start = tail.readUInt32LE(end + 16);
    if (count === 65535 || bytes > 16 * 1024 * 1024 || start + bytes !== size - tail.length + end)
      throw new Error("Invalid runtime ZIP directory");
    const directory = Buffer.alloc(bytes);
    await f.read(directory, 0, bytes, start);
    const paths = new Set<string>();
    const links: string[] = [];
    let offset = 0,
      total = 0;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > bytes || directory.readUInt32LE(offset) !== 0x02014b50)
        throw new Error("Invalid ZIP entry");
      const flags = directory.readUInt16LE(offset + 8),
        method = directory.readUInt16LE(offset + 10);
      const compressed = directory.readUInt32LE(offset + 20),
        unpacked = directory.readUInt32LE(offset + 24);
      const n = directory.readUInt16LE(offset + 28),
        extra = directory.readUInt16LE(offset + 30),
        comment = directory.readUInt16LE(offset + 32);
      const mode = directory.readUInt32LE(offset + 38) >>> 16,
        local = directory.readUInt32LE(offset + 42);
      if (
        offset + 46 + n + extra + comment > bytes ||
        flags & 1 ||
        ![0, 8].includes(method) ||
        unpacked === 0xffffffff ||
        compressed === 0xffffffff
      )
        throw new Error("Unsupported ZIP entry");
      const name = directory.subarray(offset + 46, offset + 46 + n).toString("utf8");
      if (
        !name.startsWith("CADRuntime.app/") ||
        /[\\\x00-\x1f]/.test(name) ||
        name.split("/").some((p) => p === ".." || p === ".") ||
        name.includes("//")
      )
        throw new Error("Unsafe archive path");
      const header = Buffer.alloc(30);
      await f.read(header, 0, 30, local);
      if (
        header.readUInt32LE(0) !== 0x04034b50 ||
        header.readUInt16LE(8) !== method ||
        header.readUInt16LE(6) !== flags ||
        header.readUInt16LE(26) !== n
      )
        throw new Error("Invalid ZIP local header");
      const localName = Buffer.alloc(n);
      await f.read(localName, 0, n, local + 30);
      if (!localName.equals(directory.subarray(offset + 46, offset + 46 + n)))
        throw new Error("ZIP local path differs from directory");
      if (!Buffer.from(name).equals(directory.subarray(offset + 46, offset + 46 + n)))
        throw new Error("Invalid UTF-8 archive path");
      const localExtra = Buffer.alloc(header.readUInt16LE(28));
      await f.read(localExtra, 0, localExtra.length, local + 30 + n);
      for (let x = 0; x < localExtra.length; ) {
        if (x + 4 > localExtra.length) throw new Error("Malformed local ZIP extra field");
        const kind = localExtra.readUInt16LE(x),
          length = localExtra.readUInt16LE(x + 2);
        if ([1, 0x7075].includes(kind) || x + 4 + length > localExtra.length)
          throw new Error("Unsupported local ZIP path extension");
        x += 4 + length;
      }
      const dataStart = local + 30 + n + header.readUInt16LE(28);
      if (dataStart + compressed > start) throw new Error("ZIP data overlaps directory");
      let extraOffset = offset + 46 + n;
      while (extraOffset < offset + 46 + n + extra) {
        if (extraOffset + 4 > offset + 46 + n + extra) throw new Error("Malformed ZIP extra field");
        const kind = directory.readUInt16LE(extraOffset),
          length = directory.readUInt16LE(extraOffset + 2);
        if ([1, 0x7075].includes(kind) || extraOffset + 4 + length > offset + 46 + n + extra)
          throw new Error("Unsupported ZIP path extension");
        extraOffset += 4 + length;
      }
      const key = name.replace(/\/$/, "").normalize("NFC").toLowerCase();
      if (paths.has(key)) throw new Error("Duplicate archive path");
      paths.add(key);
      // Verify actual decompressed lengths, not just attacker-controlled directory sizes.
      if (compressed) {
        const raw = createReadStream(path, { start: dataStart, end: dataStart + compressed - 1 });
        let actual = 0;
        const consume = async (source: AsyncIterable<Uint8Array>) => {
          for await (const chunk of source) {
            actual += chunk.length;
            if (actual > unpacked) throw new Error("ZIP entry exceeds advertised size");
          }
        };
        if (method === 8) await pipeline(raw, createInflateRaw(), consume);
        else await pipeline(raw, consume);
        if (actual !== unpacked) throw new Error("ZIP entry size mismatch");
      } else if (unpacked) throw new Error("ZIP entry lacks compressed data");
      const kind = mode & 0xf000;
      if (![0, 0x8000, 0x4000, 0xa000].includes(kind))
        throw new Error("Special file in runtime archive");
      total += unpacked;
      if (total > limit) throw new Error("Runtime archive exceeds advertised installed size");
      if (kind === 0xa000) {
        if (unpacked > 4096 || compressed > 8192) throw new Error("Invalid archive link");
        const data = Buffer.alloc(compressed);
        await f.read(data, 0, compressed, dataStart);
        const target = (
          method === 8 ? inflateRawSync(data, { maxOutputLength: 4096 }) : data
        ).toString("utf8");
        const resolved = posix.normalize(posix.join(posix.dirname(name), target));
        if (
          !target ||
          /[\\\x00-\x1f]/.test(target) ||
          target.startsWith("/") ||
          !resolved.startsWith("CADRuntime.app/")
        )
          throw new Error("Escaping archive link");
        links.push(key);
      }
      offset += 46 + n + extra + comment;
    }
    if (offset !== bytes) throw new Error("Unexpected ZIP directory data");
    // Reject files extracted through aliases; preserve internal framework directory symlinks.
    for (const link of links)
      for (const path of paths)
        if (path.startsWith(link + "/")) throw new Error("Archive writes through a symlink");
  } finally {
    await f.close();
  }
}
