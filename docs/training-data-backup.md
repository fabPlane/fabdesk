# Training data archive

Fabdesk already stores conversations in `fabdesk.db` and records completed agent runs as `llm-dump.json` files. Each dump includes the ordered agent and MCP tool trace. This archive preserves those records for later review and dataset preparation; it does not train a model or decide which records are suitable for training.

Run dumps inherit the capture limits described in [agent-run telemetry](agent-run-telemetry.md), so large events and project files may be truncated or omitted. Conversation messages are exported from SQLite with their stored text and parts.

## Configure a backup location

Choose a **private directory on a different disk or mounted backup volume**. The contents can include prompts, tool results, project source, and secrets entered by users or returned by tools. Limit access to the account running Fabdesk and encrypt the destination at rest. Do not put it in a project directory or a source repository.

Set `FABDESK_TRAINING_ARCHIVE_DIR` in the environment that launches the core daemon:

```bash
export FABDESK_TRAINING_ARCHIVE_DIR=/mnt/private-fabdesk-backup/training
bun run dev
```

With this set, the daemon backfills its current SQLite history on startup. Each completed run then writes an immutable run dump and a snapshot of its conversation before the bounded SQLite dump store prunes old records. If the archive write or startup backfill fails, Fabdesk logs the failure and keeps new dumps in SQLite without pruning; repair the destination and restart the daemon. Agent runs continue normally.

Run a backfill now, and periodically thereafter to capture conversations that have no completed agent run, including edits made after the last run:

```bash
bun run training:backup -- /mnt/private-fabdesk-backup/training
```

The command uses the normal Fabdesk data directory (`FABDESK_HOME` when set). Each invocation creates a dated snapshot with one JSON file per conversation and a manifest. `run-dumps/<run-id>.json` holds every dump still present in SQLite. Per-run archives are written to `conversations/<thread-id>/<run-id>.json` and `run-dumps/<run-id>.json`.

Backups retain historical conversation snapshots even if a thread is later edited or deleted in Fabdesk. Remove the corresponding files from the archive when fulfilling a deletion request. A training pipeline should curate this raw archive, remove secrets and private content, and record permission to use each example before training. A local directory is only an off-device backup when it is on a separate backed-up volume or is synchronized to private remote storage.

To check a backup, open a recent snapshot manifest and its conversation files, and parse several run dump files as JSON. To restore the raw training archive, copy the directory back; the JSON records are independent of a live Fabdesk database. This archive does not restore Fabdesk's app settings or project files.
