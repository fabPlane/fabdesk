/** Stream a complete chunked archive to disk, verifying every part and the final record. */
import { createHash } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { partKey, type ArchiveChunk, type ArchiveRecord } from "./usage-parts";

export async function restoreUsageRecord(
  record: ArchiveRecord,
  read: (key: string) => Promise<string>,
  output: string,
): Promise<void> {
  if (
    record.schema !== "fabdesk.usage-record/v1" ||
    record.encoding !== "chunked-base64" ||
    !Number.isSafeInteger(record.bytes) ||
    record.bytes < 0 ||
    !/^[a-f0-9]{64}$/.test(record.sha256) ||
    !Array.isArray(record.parts) ||
    record.parts.reduce((n, p) => n + p.bytes, 0) !== record.bytes
  )
    throw new Error("invalid chunked archive manifest");
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${crypto.randomUUID()}.part`;
  const file = await open(temporary, "wx", 0o600);
  const hash = createHash("sha256");
  try {
    for (const part of record.parts) {
      if (
        !/^[a-f0-9]{64}$/.test(part.sha256) ||
        part.key !== partKey(part.sha256) ||
        !Number.isSafeInteger(part.bytes) ||
        part.bytes <= 0
      )
        throw new Error("invalid archive part reference");
      const chunk = JSON.parse(await read(part.key)) as ArchiveChunk;
      if (
        chunk.schema !== "fabdesk.usage-chunk/v1" ||
        chunk.encoding !== "base64" ||
        chunk.sha256 !== part.sha256 ||
        chunk.bytes !== part.bytes ||
        typeof chunk.content !== "string"
      )
        throw new Error("invalid archive chunk");
      const bytes = Buffer.from(chunk.content, "base64");
      if (
        bytes.length !== part.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== part.sha256
      )
        throw new Error("archive part checksum mismatch");
      hash.update(bytes);
      await file.writeFile(bytes);
    }
    if (hash.digest("hex") !== record.sha256) throw new Error("archive record checksum mismatch");
    await file.sync();
    await file.close();
    await rename(temporary, output);
  } finally {
    await file.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}
