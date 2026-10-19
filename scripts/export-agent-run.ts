/** Exports a complete Fabdesk LLM run dump from Fabdesk's existing SQLite database. */
import { resolveConfig } from "../apps/core/src/config";
import { Store } from "../apps/core/src/db";
import { parseDumpFile } from "../apps/core/src/run-dump-file";
import { readFileSync, createReadStream } from "node:fs";
import { copyFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

function storedRunDump(runId: string, dbPath = resolveConfig().dbPath): string {
  const store = Store.open(dbPath);
  try {
    const row = store.runDumps.get(runId);
    if (!row) throw new Error(`run dump not found: ${runId}`);
    return row.dumpJson.endsWith("\n") ? row.dumpJson : `${row.dumpJson}\n`;
  } finally {
    store.close();
  }
}

export function fetchRunDump(runId: string, dbPath = resolveConfig().dbPath): string {
  const dump = storedRunDump(runId, dbPath);
  const reference = parseDumpFile(dump);
  return reference ? readFileSync(reference.path, "utf8") : dump;
}

async function main(): Promise<void> {
  const [runId, outputArg] = Bun.argv.slice(2);
  if (!runId) {
    process.stderr.write("usage: bun run runs:export -- <run-id> [output.json|-]\n");
    process.exitCode = 2;
    return;
  }
  const dump = storedRunDump(runId);
  const reference = parseDumpFile(dump);
  const output = outputArg ?? `${runId}.llm-dump.json`;
  if (output === "-") {
    if (reference) await pipeline(createReadStream(reference.path), process.stdout);
    else process.stdout.write(dump);
  }
  else {
    if (reference) await copyFile(reference.path, output);
    else await Bun.write(output, dump);
    process.stdout.write(`${output}\n`);
  }
}

if (import.meta.main) await main();
