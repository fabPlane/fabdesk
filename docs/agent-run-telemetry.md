# Agent-run telemetry

Fabdesk records every in-app Codex, Claude, Cursor and Grok run as an OpenTelemetry trace and as an exact local debug bundle. The trace is useful for comparing agent behavior across runs; the local bundle retains content that is too large or sensitive to put in a shared trace database.

## What is captured

- one root span per agent run, linked to the Fabdesk run, thread, agent session, project and model;
- one child span per MCP tool call, with the authoritative request/result ordering and MCP session id;
- one child span per `kicad-cli` process, with its executable, complete argv, cwd, exit code, stdout and stderr hashes;
- agent stream events (text, thinking, tool use/results, usage, errors and completion);
- nanosecond timestamps anchored to the wall clock with a monotonic clock;
- a content-addressed snapshot immediately before each project-scoped tool call.

The snapshot walks the project without following symlinks and excludes `.git` and `.fabdesk`. Each manifest records relative path, file type, byte size, nanosecond mtime and SHA-256. File bodies are deduplicated into a per-run `snapshots/blobs/` directory, so unchanged KiCad boards and renders are stored once across many calls.

The bundle is under `<project>/.fabdesk/runs/<run-id>/`:

```text
trace.jsonl
snapshots/
  000000.json
  000001.json
  blobs/<sha256>
```

The SQLite `runs.log_path` column points to `trace.jsonl`. Each JSONL record has `traceId`, `runId`, a strict `seq`, `timeUnixNano`, `type`, and `body`. It contains the full MCP inputs/results and KiCad stdout/stderr, and can be handed directly to Codex or Claude together with the referenced snapshot manifests.

Tracing is best-effort: a snapshot or exporter failure is recorded/logged but never fails the underlying tool call.

## Shared local database

For development and comparisons, start the checked-in Collector + Tempo + Grafana stack:

```bash
docker compose -f ops/otel/compose.yaml up -d
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_SERVICE_NAME=fabdesk-core-dev
bun run dev
```

Open `http://127.0.0.1:3000`, select the Tempo data source, and search for service `fabdesk-core-dev`. Filter or compare traces with `fabdesk.run.id`, `fabdesk.agent.id`, `rpc.method`, or `process.command_args`.

The compose stack binds only to localhost and persists data in the `fabdesk-otel-data` Docker volume. It is a debug stack, not a production deployment. For a team database, point `OTEL_EXPORTER_OTLP_ENDPOINT` (or the signal-specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) at the team's OTLP/HTTP collector instead.

By default, the shared database receives metadata, paths, hashes and statuses, while the exact content remains in the local bundle. To include truncated MCP arguments/results, agent events, and KiCad stdout/stderr in OTLP spans, explicitly opt in:

```bash
export FABDESK_OTEL_CAPTURE_CONTENT=1
```

That content may contain proprietary board data or secrets. Only enable it for a collector with appropriate access controls and retention.

The exporter also honors the standard `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_EXPORTER_OTLP_TRACES_HEADERS` and timeout environment variables. Fabdesk uses OTLP over HTTP/protobuf.
