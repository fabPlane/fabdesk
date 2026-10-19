/** Large complete dumps stay on disk; SQLite stores only this durable local reference. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export const INLINE_DUMP_BYTES = 1024 * 1024;
export type RunDumpFile = {
  schema: "fabdesk.llm-run-file/v1";
  path: string;
  bytes: number;
  sha256: string;
};

export function parseDumpFile(text: string): RunDumpFile | null {
  // References are small. Avoid parsing a potentially huge legacy inline dump just to identify it.
  if (text.length > 65536) return null;
  const value = JSON.parse(text) as Partial<RunDumpFile>;
  if (!value || typeof value !== "object" || value.schema !== "fabdesk.llm-run-file/v1")
    return null;
  if (
    typeof value.path !== "string" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes! < 0 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new Error("invalid local run-dump reference");
  return value as RunDumpFile;
}

export async function fileDumpReference(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return (
    JSON.stringify({
      schema: "fabdesk.llm-run-file/v1",
      path,
      bytes: (await stat(path)).size,
      sha256: hash.digest("hex"),
    } satisfies RunDumpFile) + "\n"
  );
}
