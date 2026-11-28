import { inflateRawSync } from "node:zlib";
import type { PackageFile } from "./types";

/** Read a ZIP (stored or deflate) into named entries. Directories are skipped. */
export function readZipEntries(data: Uint8Array): PackageFile[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const files: PackageFile[] = [];
  let offset = 0;
  while (offset + 30 <= data.length) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break;
    const method = view.getUint16(offset + 8, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const compSize = view.getUint32(offset + 18, true);
    const name = new TextDecoder().decode(data.subarray(offset + 30, offset + 30 + nameLen));
    const start = offset + 30 + nameLen + extraLen;
    const packed = data.subarray(start, start + compSize);
    offset = start + compSize;
    if (name.endsWith("/")) continue;
    const bytes = method === 0 ? packed.slice() : method === 8 ? new Uint8Array(inflateRawSync(packed)) : null;
    if (!bytes) continue;
    files.push({ name: name.replace(/\\/g, "/"), bytes });
  }
  return files;
}
