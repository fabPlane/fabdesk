# Training data archive

Fabdesk already stores conversations in `fabdesk.db` and records completed agent runs as `llm-dump.json` files. Each dump includes the ordered agent and MCP tool trace. This archive preserves those records for later review and dataset preparation; it does not train a model or decide which records are suitable for training.

Run dumps inherit the capture limits described in [agent-run telemetry](agent-run-telemetry.md), so large events and project files may be truncated or omitted. Conversation messages are exported from SQLite with their stored text and parts.

## Back up to private Cloudflare R2 through the fabplane API

Remote upload is **off by default**. It requires both an operator flag and the **Training data backup** checkbox in Fabdesk Settings → Privacy. This checkbox is installation-wide and covers all conversations and run dumps currently stored by that daemon, including existing history. It is not scoped to individual signed-in accounts. Turning it off stops future uploads but does not erase prior backups.

Set this flag in the environment that launches the core daemon:

```bash
export FABDESK_TRAINING_REMOTE_BACKUP=1
```

The daemon sends archive objects with its existing fabplane user session to `PUT /v1/private/training-archive`. The API authenticates the user and writes to private R2. **Only the API server holds the R2 credentials**; do not put them in a desktop environment or installer. The backend endpoint and its R2 bucket must be deployed before enabling this flag. Use a separate private bucket from public catalog images or downloads, with no public bucket URL or custom domain.

When consent is on, the daemon backfills current SQLite history on startup or when the checkbox is first enabled, then uploads each completed run before bounded local dump retention prunes old records. If upload fails, it logs the error and keeps new dumps locally without pruning. Fix the backend and restart to retry the backfill.

To backfill on demand with the same environment:

```bash
bun run training:backup -- --remote
```

The archive may contain credentials and proprietary project data. Review access and retention before using it for model training.

## Back up to a private directory

Choose a **private directory on a different disk or mounted backup volume**. The contents can include prompts, tool results, project source, and secrets entered by users or returned by tools. Limit access to the account running Fabdesk and encrypt the destination at rest. Do not put it in a project directory or a source repository.

The Settings → Privacy consent checkbox also gates this destination and the manual backfill command.

Set `FABDESK_TRAINING_ARCHIVE_DIR` in the environment that launches the core daemon:

```bash
export FABDESK_TRAINING_ARCHIVE_DIR=/mnt/private-fabdesk-backup/training
bun run dev
```

With this set, the daemon backfills its current SQLite history on startup. Each completed run then writes a run dump and a snapshot of its conversation before the bounded SQLite dump store prunes old records. If the archive write or startup backfill fails, Fabdesk logs the failure and keeps new dumps in SQLite without pruning; repair the destination and restart the daemon. Agent runs continue normally. Both the directory and remote destination can be enabled together.

Run a backfill now, and periodically thereafter to capture conversations that have no completed agent run, including edits made after the last run:

```bash
bun run training:backup -- /mnt/private-fabdesk-backup/training
```

The command uses the normal Fabdesk data directory (`FABDESK_HOME` when set). Each invocation creates a dated snapshot with one JSON file per conversation and a manifest. `run-dumps/<run-id>.json` holds every dump still present in SQLite. Per-run archives are written to `conversations/<thread-id>/<run-id>.json` and `run-dumps/<run-id>.json`.

Backups retain historical conversation snapshots even if a thread is later edited or deleted in Fabdesk. Remove the corresponding files from the archive when fulfilling a deletion request. A training pipeline should curate this raw archive, remove secrets and private content, and record permission to use each example before training. A local directory is only an off-device backup when it is on a separate backed-up volume or is synchronized to private remote storage.

To check a backup, open a recent snapshot manifest and its conversation files, and parse several run dump files as JSON. To restore the raw training archive, copy the directory back; the JSON records are independent of a live Fabdesk database. This archive does not restore Fabdesk's app settings or project files.
