# Agent-run dumps

Fabdesk records every in-app Codex, Claude, Cursor and Grok run as a portable, structured debug bundle. The main output is one `llm-dump.json` file designed to be attached to a fresh LLM session for analysis.

## What is captured

- agent text, thinking, tool use/results, usage, errors and completion;
- authoritative MCP request/result ordering and progress events;
- complete `kicad-cli` executable, argv, cwd, exit code, stdout and stderr, including failures;
- nanosecond timestamps anchored to the wall clock with a monotonic clock;
- a content-addressed project snapshot immediately before every project-scoped tool call.

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

`llm-dump.json` contains:

- the ordered event timeline;
- every snapshot manifest;
- every unique UTF-8 project file up to 5 MiB, keyed by SHA-256;
- metadata and omission reasons for binary or unusually large files;
- an analysis instruction telling the next model to compare each tool call with the preceding project state and KiCad result.

Text source, KiCad documents, JSON reports and SVG renders are normally embedded. PNG, GLB and other binary renders remain in the run/project directory and are represented by path, size and hash.

To analyze a run, attach `llm-dump.json` to a new Codex or Claude session and ask, for example:

> Analyze this Fabdesk run. Find where the agent misunderstood the project or KiCad state, correlate each MCP request with the preceding snapshot, and explain any unnecessary loops or failed recovery attempts.

The SQLite `runs.log_path` column points to the raw `trace.jsonl`; the LLM dump is next to it at the deterministic name `llm-dump.json`.

## Common database

Every completed dump is also stored in the `run_dumps` table of Fabdesk's existing WAL-backed SQLite database, `fabdesk.db`. This happens automatically: there is no Docker container, database server, dashboard or setup variable.

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

`runs:export` reads `fabdesk.db` from the normal data directory (or `FABDESK_HOME`) and does not modify the dump. The database copy makes all local runs available from one place; the project-local copy remains useful if a project is moved to another machine.

Optional OpenTelemetry export remains available for an already-managed OTLP/HTTP endpoint by setting `OTEL_EXPORTER_OTLP_ENDPOINT`. It is not needed to create or export LLM dumps. By default OTLP spans contain only metadata, paths, hashes and statuses; set `FABDESK_OTEL_CAPTURE_CONTENT=1` only if you also want truncated prompts, tool inputs/results and KiCad output duplicated into span attributes.
