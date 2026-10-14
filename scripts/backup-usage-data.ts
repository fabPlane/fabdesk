/** Backfill the usage archive from Fabdesk's current local database. */
import { usageArchiveAllowed } from "@fabdesk/protocol";
import { resolveConfig } from "../apps/core/src/config";
import { Store } from "../apps/core/src/db";
import { resolvePrivacyStatus } from "../apps/core/src/privacy-gate";
import { UsageArchive } from "../apps/core/src/usage-archive";

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  const all = args.includes("--all");
  const destination = args.find((arg) => arg !== "--all") ?? process.env["FABDESK_USAGE_ARCHIVE_DIR"];
  if (!destination?.trim()) {
    process.stderr.write("usage: bun run usage:backup -- [--all] <private-backup-directory>|--remote\n");
    process.exitCode = 2;
    return;
  }
  const store = Store.open(resolveConfig().dbPath);
  try {
    const { firstInstallScreen } = resolvePrivacyStatus({ settings: store.settings });
    const allowed = () => usageArchiveAllowed(store.settings.get(), firstInstallScreen);
    if (!allowed()) throw new Error("enable Share usage data in Fabdesk Settings > Privacy before exporting");
    if (destination === "--remote") {
      const config = resolveConfig();
      const { createAuth } = await import("../apps/core/src/auth-facade");
      const { UsageApiArchiveWriter } = await import("../apps/core/src/usage-api");
      const auth = await createAuth({
        mode: config.authMode,
        channel: config.channel,
        home: config.home,
        apiOrigin: config.apiOrigin,
        emit: () => {},
      });
      const counts = await new UsageArchive(
        new UsageApiArchiveWriter(config.apiOrigin, () => auth.token(), store.settings),
      ).backfill(store.db, allowed, { all });
      process.stdout.write(JSON.stringify({ destination: "remote", ...counts }) + "\n");
    } else {
      const counts = await new UsageArchive(destination).backfill(store.db, allowed, { all });
      process.stdout.write(JSON.stringify({ directory: destination, ...counts }) + "\n");
    }
  } finally {
    store.close();
  }
}

if (import.meta.main) await main();
