/** Backfill the opt-in training archive from Fabdesk's current local database. */
import { resolveConfig } from "../apps/core/src/config";
import { Store } from "../apps/core/src/db";
import { TrainingArchive } from "../apps/core/src/training-archive";

async function main(): Promise<void> {
  const destination = Bun.argv[2] ?? process.env["FABDESK_TRAINING_ARCHIVE_DIR"];
  if (!destination?.trim()) {
    process.stderr.write("usage: bun run training:backup -- <private-backup-directory>|--r2\n");
    process.exitCode = 2;
    return;
  }
  const store = Store.open(resolveConfig().dbPath);
  try {
    if (destination === "--r2") {
      const { r2ArchiveConfig, R2ArchiveWriter } = await import("../apps/core/src/training-r2");
      const config = r2ArchiveConfig();
      if (!config) throw new Error("set FABDESK_TRAINING_R2_ENABLED=1 to back up to R2");
      const writer = new R2ArchiveWriter(config);
      try {
        const counts = await new TrainingArchive(writer).backfill(store.db);
        process.stdout.write(
          JSON.stringify({
            destination: "r2",
            bucket: config.bucket,
            prefix: config.prefix,
            ...counts,
          }) + "\n",
        );
      } finally {
        writer.close();
      }
    } else {
      const counts = await new TrainingArchive(destination).backfill(store.db);
      process.stdout.write(JSON.stringify({ directory: destination, ...counts }) + "\n");
    }
  } finally {
    store.close();
  }
}

if (import.meta.main) await main();
