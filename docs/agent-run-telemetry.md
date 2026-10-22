# Agent-run dumps

Fabdesk records every in-app Codex, Claude, Cursor and Grok run as a portable, structured debug bundle. The main output is one `llm-dump.json` file designed to be attached to a fresh LLM session for analysis.

## What is captured

- agent text, thinking, tool use/results, usage, errors and completion;
- authoritative MCP request/result ordering and progress events;
- complete `kicad-cli` executable, argv, cwd, exit code, stdout and stderr, including failures;
- nanosecond timestamps anchored to the wall clock with a monotonic clock;
- a content-addressed project snapshot immediately before every project-scoped tool call.

## Build identity

The `run.started` event carries a `build` object, so usage analysis can tell which fabdesk produced
a run (`apps/core/src/build-info.ts`):

```json
"build": { "version": "0.2.0", "kind": "dev", "label": null, "commit": "5067af9", "branch": "traditional-v2", "dirty": true, "channel": "public", "builtAt": null }
```

| `kind` | When | `commit` / `branch` / `dirty` |
| --- | --- | --- |
| `release` | a compiled `fabdesk-core` | baked in by `apps/core/scripts/build.ts` (`FABDESK_BUILD_*` defines); `builtAt` is set |
| `dev` | running from a checkout | read from git in that checkout when the daemon starts |
| `candidate` | either, launched with `FABDESK_BUILD_LABEL=<name>` | as above; `label` names the line of work |

`dirty: true` means uncommitted changes to tracked files, so the commit alone does not reproduce
the build. The release version stamp `scripts/set-version.ts` writes in CI (the version fields in the
package.json files and the mobile `app.json`) is ignored; any other change, including other edits to
those files, counts. `dirty: null` means git couldn't tell. To make a
benchmark build easy to find later, launch it with a label:

```bash
FABDESK_BUILD_LABEL=traditional-v2 bun run dev
```

`channel` is the existing public/internal feature channel, unrelated to `kind`.

The snapshot walks the project without following symlinks and excludes `.git` and `.fabdesk`. Each manifest records relative path, file type, byte size, nanosecond mtime and SHA-256. File bodies are deduplicated, so an unchanged KiCad board is stored once across many tool calls.

## Files

Each run writes under `<project>/.fabdesk/runs/<run-id>/`:

```text
llm-dump.json              # single-file dump to give another LLM
trace.jsonl                # append-only raw event stream
snapshots/
  000000.json              # exact pre-tool file manifest
  000001.json
  blobs/<sha256>           # deduplicated original file bodies
```

`llm-dump.json` contains the complete ordered event timeline, every distinct snapshot manifest,
and every unique captured project file. Small UTF-8 files are embedded directly; large or binary
files use base64 so their exact bytes survive export. The final project state is captured after
the agent exits, including files written by native shell/file tools. Pre-tool snapshots are taken
for project-scoped Fabdesk calls; native agent calls also appear in the agent timeline.

Capture has no policy limits on event size, total events, file size/count, snapshot count or total
dump size. Events append to disk; file hashing/copying and portable-dump export stream through
bounded memory windows. Unchanged files and project states remain deduplicated. Local history
keeps the newest 50 run directories per project and a SQLite cache of 100 rows / 512 MiB,
with or without backup enabled. Runs beyond those limits remain until every destination required
when captured has acknowledged them; captures made with backup off need no acknowledgement.
The daemon indexes capture ownership at start, including captures interrupted before dump creation,
and registers completed dumps at finalization. With no local archive directory and the remote
backup flag unset or set to `0`, captures require no destinations and attempt no uploads.
Profile `run-dumps/` copies are removed together with their SQLite row. Current runs and the newest
run are protected. A separate 5 GiB pending-backup storage cap can drop older unsent runs: see
[usage data archive](usage-data-backup.md) for accounting and internal durable drop records. `.git`, `.fabdesk` and symlink targets remain outside the
captured file tree; symlinks themselves are recorded. Files that change while being copied are retried once; a second change becomes an explicit
per-file manifest error and the snapshot continues. I/O/serialization errors are reported explicitly. Complete capture still requires working storage,
and cannot recover content an agent CLI itself withheld or truncated.

Small dumps are also stored directly in SQLite. For dumps over 1 MiB, `run_dumps.dump_json` holds
a `fabdesk.llm-run-file/v1` descriptor with the immutable local file's path, full byte size and
SHA-256 instead of loading the whole run into a database string. The daemon keeps a stable copy
under its profile's `run-dumps/` directory (a hard link where possible), so moving or deleting the
project does not erase a pending backup. This threshold changes storage
representation only; no content is omitted. `runs:export` resolves either representation and
streams large dumps to a file or stdout. Consumers that read SQLite directly must resolve the
reference; do not treat that small descriptor as the run's size/content.

Remote backup uses checked transport chunks and a final manifest; see
[usage data archive](usage-data-backup.md). A 60 MB run is a complete logical run even though
no single network request contains 60 MB. Older truncated runs remain truncated; these changes
apply to new captures.

Agent stream events are buffered and appended in batches. Snapshot, serialization, exporter and span-event failures are isolated from the agent run.

To analyze a run, attach `llm-dump.json` to a new Codex or Claude session and ask, for example:

> Analyze this Fabdesk run. Find where the agent misunderstood the project or KiCad state, correlate each MCP request with the preceding snapshot, and explain any unnecessary loops or failed recovery attempts.

The SQLite `runs.log_path` column points to the raw `trace.jsonl`; the LLM dump is next to it at the deterministic name `llm-dump.json`.

## Common database

Every completed dump or its verified file reference is also stored in the `run_dumps` table of Fabdesk's existing WAL-backed SQLite database, `fabdesk.db`. This happens automatically: there is no Docker container, database server, dashboard or setup variable.

The database lives under the normal platform-specific Fabdesk data directory. Set `FABDESK_HOME` if you want an explicit, easy-to-find location:

```bash
export FABDESK_HOME="$PWD/.fabdesk-dev"
bun run dev
```

Fetch one complete dump into a file for another LLM session:

```bash
bun run runs:export -- run_abc123
# writes run_abc123.llm-dump.json
```

Pass a second argument for a different output path, or `-` for stdout.

`runs:export` reads `fabdesk.db` from the normal data directory (or `FABDESK_HOME`), resolves file-backed records and does not modify the dump. Keep the profile's pending `run-dumps/` files available until backup has completed. The database record makes retained runs discoverable; the project-local bundle remains useful when a project is moved. For long-term retention of conversations and run dumps, see [usage data archive](usage-data-backup.md).

Optional OpenTelemetry export remains available for an already-managed OTLP/HTTP endpoint by setting `OTEL_EXPORTER_OTLP_ENDPOINT`. It is not needed to create or export LLM dumps. By default OTLP spans contain only metadata, paths, hashes and statuses; set `FABDESK_OTEL_CAPTURE_CONTENT=1` only if you also want truncated prompts, tool inputs/results and KiCad output duplicated into span attributes.
