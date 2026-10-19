/** Restore a logical archive record from a private exported installation directory. */
import { copyFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { restoreUsageRecord } from "../apps/core/src/restore-usage-record";

const [installationDirectory, recordKey, output] = Bun.argv.slice(2);
if (!installationDirectory || !recordKey || !output)
  throw new Error(
    "usage: bun run usage:restore -- <installation-directory> <record-key> <output.json>",
  );
const source = resolve(installationDirectory, recordKey);
const prefix = await Bun.file(source).slice(0, 512).text();
if (/^\s*\{\s*"schema"\s*:\s*"fabdesk\.usage-record\/v1"/.test(prefix)) {
  await restoreUsageRecord(
    JSON.parse(await readFile(source, "utf8")),
    (key) => readFile(resolve(installationDirectory, key), "utf8"),
    output,
  );
} else await copyFile(source, output);
process.stdout.write(`${output}\n`);
