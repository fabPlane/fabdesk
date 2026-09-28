/** Backfill the opt-in training archive from Fabdesk's current local database. */
import { resolveConfig } from "../apps/core/src/config";
import { Store } from "../apps/core/src/db";
import { TrainingArchive } from "../apps/core/src/training-archive";

async function main(): Promise<void> {
  const directory = Bun.argv[2] ?? process.env["FABDESK_TRAINING_ARCHIVE_DIR"];
  if (!directory?.trim()) {
    process.stderr.write("usage: bun run training:backup -- <private-backup-directory>\n");
    process.exitCode = 2;
    return;
  }
  const store = Store.open(resolveConfig().dbPath);
  try {
    const counts = await new TrainingArchive(directory).backfill(store.db);
    process.stdout.write(JSON.stringify({ directory, ...counts }) + "\n");
  } finally {
    store.close();
  }
}

if (import.meta.main) await main();
