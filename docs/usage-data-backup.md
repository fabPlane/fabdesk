# Usage data archive

Fabdesk already stores conversations in `fabdesk.db` and records completed agent runs as `llm-dump.json` files. Each dump includes the ordered agent and MCP tool trace. This archive preserves those records for later analysis.

Run dumps inherit the capture limits described in [agent-run telemetry](agent-run-telemetry.md), so large events and project files may be truncated or omitted. Conversation messages are exported from SQLite with their stored text and parts.

## Back up to private Cloudflare R2 through the fabplane API

Installed desktop apps activate remote upload automatically, subject to usage-data consent.
Unpackaged development launches, packaged development profiles and standalone core launches
require the operator flag described below. The consent rules are:

- **A saved choice always wins.** That covers both the first-install **Help improve Fabdesk** screen (`FirstInstallPrivacy`) and **Share usage data** in Settings → Privacy, so people who opted out stay opted out.
- **Outside the consent region, sharing is on by default with no startup prompt.** Undecided installations can turn it off in Settings → Privacy.
- **In the consent region, undecided installations must opt in first.** The screen's checkbox starts unchecked, and nothing uploads until the person clicks Continue with it checked.

The choice is installation-wide and covers existing conversations and run dumps. Turning it off
cancels waiting uploads and retries, and aborts requests still in flight. Data the server already
received is not erased. Turning sharing on again resumes backup of unsent records.

The core daemon decides once at startup whether the screen is required and serves the answer at `GET /privacy`, so every client gates on the same answer the uploader uses. `FIRST_INSTALL_PRIVACY_SCREEN` in `packages/protocol/src/api.ts` is `auto`. To force a mode for a single run without rebuilding, set `FABDESK_PRIVACY_SCREEN=always|never|auto` in the core's environment.

`auto` shows the screen only where the installation is likely in the EU/EEA, UK or Switzerland, and backs everyone else up by default. It matches the system time zone against `CONSENT_REGION_TIME_ZONES` and each OS locale region against `CONSENT_REGION_COUNTRIES` (`packages/protocol/src/privacy-region.ts`); the locales come from `FABDESK_SYSTEM_LOCALES` (the desktop app passes Electron's system locale and preferred languages), then `LC_ALL`, `LC_MESSAGES`, `LANG` and `LANGUAGE`. The core remembers an installation once detected in the region. This is a heuristic: a VPN does not change it, and anyone can set any zone or locale.

To enable remote upload for a development or standalone core launch, set this flag in the
environment that launches the daemon:

```bash
export FABDESK_USAGE_REMOTE_BACKUP=1
```

An explicit value is preserved in every launch mode. Set `FABDESK_USAGE_REMOTE_BACKUP=0` to
disable the uploader for an installed desktop launch. This operator switch never overrides a
saved privacy opt-out or the first-install consent requirement; users can still turn sharing off
in Settings → Privacy.

The daemon registers a random installation UUID with the API, stores the signed upload token locally, and sends archive objects to `PUT /v1/usage-archive`. Fabplane sign-in is optional for the upload. When signed in, the API records an account link for the same installation UUID. The API checks the token, upload size and basic rate limits, then writes to private R2. **Only the API server holds the R2 credentials**; do not put them in a desktop environment or installer. The backend endpoint and its R2 bucket must be deployed before enabling this flag. Use a separate private bucket from public catalog images or downloads, with no public bucket URL or custom domain.

When consent is on, the daemon backfills current SQLite history in the background on startup or when the checkbox is first enabled, then uploads each completed run before bounded local dump retention prunes old records. The daemon records a content hash of each conversation and run dump it has sent to a destination (the `usage_archive_uploads` table), so a backfill sends only new or changed records rather than all history on every launch. Uploads are paced under the API's per-installation rate limit (about 100 a minute) and retry 429, 5xx and network failures a few times with backoff, honouring a short `Retry-After`. A record over the API's 40 MiB limit is skipped without being sent. If the backfill still fails (for example a daily limit), the daemon logs it and retries the backfill every 30 minutes; no restart is needed.

Local run-dump retention (100 dumps / 512 MiB, `RUN_DUMP_RETENTION` in `apps/core/src/db.ts`) keeps any dump a destination has not received yet, so a later backfill can still send it, up to a hard ceiling of 200 dumps / 1 GiB. Past the ceiling the oldest dumps are pruned whether or not they were backed up, so a destination that keeps failing cannot grow `fabdesk.db` without bound.

To backfill on demand with the same environment:

```bash
bun run usage:backup -- --remote
```

The archive may contain credentials and proprietary project data. Limit access and set an appropriate retention period before analyzing it.

## Back up to a private directory

Choose a **private directory on a different disk or mounted backup volume**. The contents can include prompts, tool results, project source, and secrets entered by users or returned by tools. Limit access to the account running Fabdesk and encrypt the destination at rest. Do not put it in a project directory or a source repository.

The same consent (saved choice or the default above) also gates this destination and the manual backfill command.

Set `FABDESK_USAGE_ARCHIVE_DIR` in the environment that launches the core daemon:

```bash
export FABDESK_USAGE_ARCHIVE_DIR=/mnt/private-fabdesk-backup/usage
bun run dev
```

With this set, the daemon backfills its current SQLite history on startup. Each completed run then writes a run dump and a snapshot of its conversation before the bounded SQLite dump store prunes old records. If the archive write or startup backfill fails, Fabdesk logs the failure, keeps dumps the directory has not received (within the retention ceiling above) and retries the backfill every 30 minutes. Agent runs continue normally. Both the directory and remote destination can be enabled together.

Run a backfill now, and periodically thereafter to capture conversations that have no completed agent run, including edits made after the last run:

```bash
bun run usage:backup -- /mnt/private-fabdesk-backup/usage
```

The command uses the normal Fabdesk data directory (`FABDESK_HOME` when set). Each invocation creates a dated snapshot with one JSON file per conversation that is new or changed since the last backup to that destination, plus a manifest; nothing is written when nothing changed. Pass `--all` to write every conversation and run dump again, for example after replacing the backup volume. `run-dumps/<run-id>.json` holds every dump still present in SQLite. Per-run archives are written to `conversations/<thread-id>/<run-id>.json` and `run-dumps/<run-id>.json`.

Backups retain historical conversation snapshots even if a thread is later edited or deleted in Fabdesk. Remove the corresponding files from the archive when fulfilling a deletion request. Analysis should account for secrets and private content in these raw records. A local directory is only an off-device backup when it is on a separate backed-up volume or is synchronized to private remote storage.

To check a backup, open a recent snapshot manifest and its conversation files, and parse several run dump files as JSON. To restore the raw usage archive, copy the directory back; the JSON records are independent of a live Fabdesk database. This archive does not restore Fabdesk's app settings or project files.
