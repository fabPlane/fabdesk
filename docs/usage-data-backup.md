# Usage data archive

Fabdesk already stores conversations in `fabdesk.db` and records completed agent runs as `llm-dump.json` files. Each dump includes the ordered agent and MCP tool trace. This archive preserves those records for later analysis.

Run dumps inherit the capture limits described in [agent-run telemetry](agent-run-telemetry.md), so large events and project files may be truncated or omitted. Conversation messages are exported from SQLite with their stored text and parts.

## Back up to private Cloudflare R2 through the fabplane API

Remote upload requires an operator flag and a saved first-install privacy choice. The initial screen shows **Back up my usage data for analysis** checked; nothing uploads until the person clicks Continue. They can uncheck it first or change **Usage data backup** later in Settings → Privacy. The choice is installation-wide and covers existing conversations and run dumps. Turning it off stops future uploads but does not erase prior backups.

Set this flag in the environment that launches the core daemon:

```bash
export FABDESK_USAGE_REMOTE_BACKUP=1
```

The daemon registers a random installation UUID with the API, stores the signed upload token locally, and sends archive objects to `PUT /v1/usage-archive`. Fabplane sign-in is optional for the upload. When signed in, the API records an account link for the same installation UUID. The API checks the token, upload size and basic rate limits, then writes to private R2. **Only the API server holds the R2 credentials**; do not put them in a desktop environment or installer. The backend endpoint and its R2 bucket must be deployed before enabling this flag. Use a separate private bucket from public catalog images or downloads, with no public bucket URL or custom domain.

When consent is on, the daemon backfills current SQLite history on startup or when the checkbox is first enabled, then uploads each completed run before bounded local dump retention prunes old records. If upload fails, it logs the error and keeps new dumps locally without pruning. Fix the backend and restart to retry the backfill.

To backfill on demand with the same environment:

```bash
bun run usage:backup -- --remote
```

The archive may contain credentials and proprietary project data. Limit access and set an appropriate retention period before analyzing it.

## Back up to a private directory

Choose a **private directory on a different disk or mounted backup volume**. The contents can include prompts, tool results, project source, and secrets entered by users or returned by tools. Limit access to the account running Fabdesk and encrypt the destination at rest. Do not put it in a project directory or a source repository.

The saved first-install choice and Settings → Privacy checkbox also gate this destination and the manual backfill command.

Set `FABDESK_USAGE_ARCHIVE_DIR` in the environment that launches the core daemon:

```bash
export FABDESK_USAGE_ARCHIVE_DIR=/mnt/private-fabdesk-backup/usage
bun run dev
```

With this set, the daemon backfills its current SQLite history on startup. Each completed run then writes a run dump and a snapshot of its conversation before the bounded SQLite dump store prunes old records. If the archive write or startup backfill fails, Fabdesk logs the failure and keeps new dumps in SQLite without pruning; repair the destination and restart the daemon. Agent runs continue normally. Both the directory and remote destination can be enabled together.

Run a backfill now, and periodically thereafter to capture conversations that have no completed agent run, including edits made after the last run:

```bash
bun run usage:backup -- /mnt/private-fabdesk-backup/usage
```

The command uses the normal Fabdesk data directory (`FABDESK_HOME` when set). Each invocation creates a dated snapshot with one JSON file per conversation and a manifest. `run-dumps/<run-id>.json` holds every dump still present in SQLite. Per-run archives are written to `conversations/<thread-id>/<run-id>.json` and `run-dumps/<run-id>.json`.

Backups retain historical conversation snapshots even if a thread is later edited or deleted in Fabdesk. Remove the corresponding files from the archive when fulfilling a deletion request. Analysis should account for secrets and private content in these raw records. A local directory is only an off-device backup when it is on a separate backed-up volume or is synchronized to private remote storage.

To check a backup, open a recent snapshot manifest and its conversation files, and parse several run dump files as JSON. To restore the raw usage archive, copy the directory back; the JSON records are independent of a live Fabdesk database. This archive does not restore Fabdesk's app settings or project files.
