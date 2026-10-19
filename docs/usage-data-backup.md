# Usage data archive

Fabdesk already stores conversations in `fabdesk.db` and records completed agent runs as `llm-dump.json` files. Each dump includes the ordered agent and MCP tool trace. This archive preserves those records for later analysis.

Run dumps capture full events and project files as described in [agent-run telemetry](agent-run-telemetry.md); capture errors are explicit. Conversation messages are exported from SQLite with their stored text and parts.

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

The daemon registers a random installation UUID with the API and stores its signed upload token
locally. Sign-in is optional; the desktop never receives R2 credentials. Existing installation,
consent, opt-out cancellation and default-region rules still apply.

### Complete large records

The original capture/export is kept on disk in full. Small JSON records upload directly. Larger
records upload as **512 KiB raw pieces**, wrapped as JSON/base64, each with its byte size and
SHA-256. This fits deployed ingress limits as well as the API's 40 MiB per-request limit. Part
size is a transport window, not a per-run limit. Large binary files are captured too.

Each accepted content-addressed piece gets a durable local receipt scoped to its logical record.
Conversation scopes use the thread identity so resuming a backfill with a new snapshot id can
reuse accepted pieces. Retry or restart resends
only pieces without receipts. After every piece is accepted, the daemon writes a
`fabdesk.usage-record/v1` completion manifest at the original run/conversation key. Only then is
the logical record marked backed up. Receipts for its pieces are then deleted from local settings;
a later record may send shared pieces again. Storage-cap drops also clear that run's scoped receipts. Legacy shared receipts remain usable during resume and are cleared when encountered on completion. Reading that manifest reconstructs the original bytes and
checks every piece and the full record hash; missing/corrupt data fails rather than returning a
partial run.

The existing deployed API accepts these keys without a backend change:

```text
run-dumps/<run-id>.json                         # ordinary dump or completion manifest
conversations/<thread-id>/<run-id>.json          # ordinary record or completion manifest
snapshots/chunk-<sha256>/manifest.json           # checked base64 piece
```

Old consumers that expect every run key to contain inline `events` must use reconstruction first.
The internal usage-lens reader understands both formats. After privately exporting an installation's
objects, restore a standalone full run with:

```bash
bun run usage:restore -- /private/export/<installation-id> run-dumps/<run-id>.json /private/full-run.json
```

The daemon saves the local file/reference before reporting agent completion. Network uploads
run separately and cannot hold up the next model turn. Failed uploads schedule backfill retries;
accepted pieces survive a restart. Uploads remain paced under installation/IP request and byte
quotas. A daily quota can delay a very large backup across quota windows; it never makes that
record count as delivered. Pending local files remain subject to the storage cap below.

Local history keeps the newest **50 run directories per project** and a **100-row / 512 MiB
SQLite cache**, whether sharing is on or off. The SQLite byte limit counts the actual stored
payload (a small descriptor for file-backed dumps). Profile `run-dumps/` files are deleted with
their SQLite rows. Beyond the normal limits, a run is eligible only when it required no destination
at capture or every required destination has acknowledged it. Switching sharing off does not
remove a pending run's original destination requirements. Cleanup runs at startup, capture and
acknowledgement, so successful backfill releases old copies without needing another run.

Pending runs have a separate **5 GiB total local storage cap**. Accounting includes project run
traces, snapshot blobs/manifests and bundled dumps, profile copies, and inline SQLite payloads.
Each run's project/profile hard links are counted once by device/inode; SQLite payloads are a separate copy.
Capture ownership and required destinations are indexed before directory creation, so failed dump
creation or a core exit leaves the capture eligible for cleanup. Startup also recovers older
interrupted captures from owned `runs.log_path` directories; unknown folders remain untouched.
Active captures are protected and their changing footprints are not cached.
Each immutable capture's directory/profile footprint and their shared hard-link bytes are measured
once when finalized and stored in the independent history index. Pruning sums those stored sizes
and SQLite-computed payload byte lengths plus bounded file-reference metadata, without loading
inline payloads or walking finalized run trees. Cleanup checks directory roots for project purges;
missing directories stop contributing bytes and surviving profile hard links remain fully charged.
Known legacy histories with no
stored footprint are measured once on cleanup; successful measurements survive restart and cache
eviction. Successful directory/profile deletion updates the corresponding stored bytes. A partial
filesystem failure keeps a conservative estimate until deletion succeeds on a later cleanup.
Sizing/deletion failures are isolated to that history and logged internally; other histories still
prune. A failed legacy measurement keeps its unknown footprint and is protected until a later
successful measurement. The cap can remain exceeded while inaccessible storage cannot be sized
or removed.
When the cap is exceeded, the oldest unprotected unsent runs are dropped until under it. Each drop
is permanently recorded in SQLite `run_backup_drops` with run id, bytes, reason and UTC time,
with optional internal debug logging; no notice, warning, dialog or status is shown to the user. A dropped run is never marked delivered, even if
an already-running request finishes. Dropping an in-flight record cancels that record and lets
backfill continue with the surviving backlog, including when pruning makes source-file I/O fail
before the next retention callback. Other I/O failures still propagate, and actual consent
revocation still stops the upload.
Current runs and the newest run per project remain
protected; if these alone exceed the cap, Fabdesk retains the excess and records it only in the internal debug log. The cap is checked
between captures/uploads, rather than stopping an active capture midway.

A small `run_dump_history` index preserves cleanup eligibility independently of the dump cache.
Known older database dumps are adopted with their recorded destinations; historical rows with no
required destination remain eligible. Unindexed legacy folders whose backup state is unknown are
preserved. Cleanup deletes only known run-history directories and profile dump files, never the
real project. Filesystem errors defer cleanup and remain in the internal debug log rather than erasing metadata or pretending
an upload succeeded.
The deployed route checks the signed installation token, JSON and body SHA-256. Content hashes
also identify chunks and the full original record. No full-dump R2 object is published until the
logical backup is committed. No R2 public URL or bucket credentials are added to the desktop.

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
