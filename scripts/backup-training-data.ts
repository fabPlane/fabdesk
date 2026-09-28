/** Backfill the opt-in training archive from Fabdesk's current local database. */
import { resolveConfig } from "../apps/core/src/config";
import { Store } from "../apps/core/src/db";
import { TrainingArchive } from "../apps/core/src/training-archive";

async function main(): Promise<void> {
  const destination = Bun.argv[2] ?? process.env["FABDESK_TRAINING_ARCHIVE_DIR"];
  if (!destination?.trim()) {
    process.stderr.write("usage: bun run training:backup -- <private-backup-directory>|--remote\n");
    process.exitCode = 2;
    return;
  }
  const store = Store.open(resolveConfig().dbPath);
  try {
    if (!store.settings.get().trainingArchiveConsent) {
      throw new Error("enable Training data backup in Fabdesk Settings > Privacy before exporting");
    }
    const allowed = () => store.settings.get().trainingArchiveConsent;
    if (destination === "--remote") {
      const config = resolveConfig();
      const { createAuth } = await import("../apps/core/src/auth-facade");
      const { TrainingApiArchiveWriter } = await import("../apps/core/src/training-api");
      const auth = await createAuth({
        mode: config.authMode,
        channel: config.channel,
        home: config.home,
        apiOrigin: config.apiOrigin,
        emit: () => {},
      });
      const counts = await new TrainingArchive(
        new TrainingApiArchiveWriter(config.apiOrigin, () => auth.token()),
      ).backfill(store.db, allowed);
      process.stdout.write(JSON.stringify({ destination: "remote", ...counts }) + "\n");
    } else {
      const counts = await new TrainingArchive(destination).backfill(store.db, allowed);
      process.stdout.write(JSON.stringify({ directory: destination, ...counts }) + "\n");
    }
  } finally {
    store.close();
  }
}

if (import.meta.main) await main();
