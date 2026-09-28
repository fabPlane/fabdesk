# Training data archive

Fabdesk already stores conversations in `fabdesk.db` and records completed agent runs as `llm-dump.json` files. Each dump includes the ordered agent and MCP tool trace. This archive preserves those records for later review and dataset preparation; it does not train a model or decide which records are suitable for training.

Run dumps inherit the capture limits described in [agent-run telemetry](agent-run-telemetry.md), so large events and project files may be truncated or omitted. Conversation messages are exported from SQLite with their stored text and parts.

## Back up to private Cloudflare R2

R2 upload is **off by default**. This is an installation-level opt-in: enabling it sends all conversations and run dumps currently stored by that daemon, including existing history. It does not record individual user consent. Use a private bucket with no public bucket URL or custom domain, and create a bucket-scoped R2 token with object read/write access. Fabdesk uses Cloudflare's [S3-compatible endpoint](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/) and the `auto` region.

Set these variables in the environment that launches the core daemon:

```bash
export FABDESK_TRAINING_R2_ENABLED=1
export FABDESK_TRAINING_R2_ACCOUNT_ID=<32-character-account-id>
export FABDESK_TRAINING_R2_BUCKET=<private-bucket-name>
export FABDESK_TRAINING_R2_ACCESS_KEY_ID=<bucket-scoped-access-key-id>
export FABDESK_TRAINING_R2_SECRET_ACCESS_KEY=<bucket-scoped-secret-access-key>
export FABDESK_TRAINING_R2_PREFIX=fabdesk-training/v1  # optional default
```

The daemon backfills the current SQLite history on startup, then uploads each completed run before bounded local dump retention prunes old records. If configuration or upload fails, it logs the error and keeps new dumps locally without pruning. Fix the configuration and restart to retry the backfill. No R2 request is made unless `FABDESK_TRAINING_R2_ENABLED=1`.

To backfill on demand with the same environment:

```bash
bun run training:backup -- --r2
```

Use a separate private bucket from public catalog images or downloads. The archive may contain credentials and proprietary project data. Review access and retention before using it for model training.

## Back up to a private directory

Choose a **private directory on a different disk or mounted backup volume**. The contents can include prompts, tool results, project source, and secrets entered by users or returned by tools. Limit access to the account running Fabdesk and encrypt the destination at rest. Do not put it in a project directory or a source repository.

Set `FABDESK_TRAINING_ARCHIVE_DIR` in the environment that launches the core daemon:

```bash
export FABDESK_TRAINING_ARCHIVE_DIR=/mnt/private-fabdesk-backup/training
bun run dev
```

With this set, the daemon backfills its current SQLite history on startup. Each completed run then writes a run dump and a snapshot of its conversation before the bounded SQLite dump store prunes old records. If the archive write or startup backfill fails, Fabdesk logs the failure and keeps new dumps in SQLite without pruning; repair the destination and restart the daemon. Agent runs continue normally. Both the directory and R2 destination can be enabled together.

Run a backfill now, and periodically thereafter to capture conversations that have no completed agent run, including edits made after the last run:

```bash
bun run training:backup -- /mnt/private-fabdesk-backup/training
```

The command uses the normal Fabdesk data directory (`FABDESK_HOME` when set). Each invocation creates a dated snapshot with one JSON file per conversation and a manifest. `run-dumps/<run-id>.json` holds every dump still present in SQLite. Per-run archives are written to `conversations/<thread-id>/<run-id>.json` and `run-dumps/<run-id>.json`.

Backups retain historical conversation snapshots even if a thread is later edited or deleted in Fabdesk. Remove the corresponding files from the archive when fulfilling a deletion request. A training pipeline should curate this raw archive, remove secrets and private content, and record permission to use each example before training. A local directory is only an off-device backup when it is on a separate backed-up volume or is synchronized to private remote storage.

To check a backup, open a recent snapshot manifest and its conversation files, and parse several run dump files as JSON. To restore the raw training archive, copy the directory back; the JSON records are independent of a live Fabdesk database. This archive does not restore Fabdesk's app settings or project files.
