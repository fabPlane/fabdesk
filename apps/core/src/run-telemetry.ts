/** OpenTelemetry spans plus a bounded local JSONL bundle for agent-run debugging. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-node";
import type { ToolOutput, ToolTelemetry } from "@fabdesk/tools";
import type { KicadInvocation, RunResult } from "@fabdesk/kicad";
import { errMsg, logger } from "./log";

type RunRecord = {
  runId: string;
  threadId: string;
  agentId: string;
  projectId: string | null;
  traceId: string;
  dir: string;
  logPath: string;
  span: Span;
  otelContext: Context;
  seq: number;
  snapshotSeq: number;
  pending: TraceRecord[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  traceBytes: number;
  traceTruncated: boolean;
  writes: Promise<void>;
  snapshotCache: Map<string, SnapshotCacheEntry>;
  blobHashes: Set<string>;
  blobBytes: number;
  snapshotManifestBytes: number;
  lastSnapshot: { stateSha256: string; result: SnapshotResult } | null;
  snapshotDirty: boolean;
  finalization: Promise<void> | null;
};

type TraceRecord = {
  schema: 1;
  traceId: string;
  runId: string;
  seq: number;
  timeUnixNano: string;
  type: string;
  body: unknown;
};

type ToolScope = { run: RunRecord; context: Context; tool: string };

export type AgentTrace = {
  logPath: string;
  record(type: string, body: unknown): void;
  finish(
    status: "completed" | "aborted" | "failed",
    details?: Record<string, unknown>,
  ): Promise<void>;
};

export type RunDumpSink = {
  put(dump: {
    runId: string;
    traceId: string;
    threadId: string;
    agentId: string;
    projectId: string | null;
    createdAt: string;
    dumpJson: string;
  }): void | Promise<void>;
};

export type RunTelemetryOptions = { version: string; runDumps?: RunDumpSink };

export const RUN_TELEMETRY_LIMITS = {
  traceBytes: 12 * 1024 * 1024,
  eventBytes: 2 * 1024 * 1024,
  snapshotFileBytes: 5 * 1024 * 1024,
  snapshotBlobBytes: 16 * 1024 * 1024,
  snapshotManifestBytes: 8 * 1024 * 1024,
  snapshotFiles: 2_000,
  snapshots: 128,
  dumpBlobBytes: 8 * 1024 * 1024,
  dumpBytes: 32 * 1024 * 1024,
  localRuns: 50,
} as const;

const NS_PER_MS = 1_000_000n;
const clockWallNs = BigInt(Date.now()) * NS_PER_MS;
const clockMonoNs = process.hrtime.bigint();
const unixNano = () => (clockWallNs + process.hrtime.bigint() - clockMonoNs).toString();
const json = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item instanceof Error ? { name: item.name, message: item.message, stack: item.stack } : item,
  ) ?? "null";
const clip = (value: unknown, max = 32_000) => {
  const text = json(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
};
const hashText = (value: unknown) => createHash("sha256").update(json(value)).digest("hex");

class LazyOtlpExporter implements SpanExporter {
  private exporter: Promise<SpanExporter> | null = null;

  private get(): Promise<SpanExporter> {
    return (this.exporter ??= import("@opentelemetry/exporter-trace-otlp-proto").then(
      ({ OTLPTraceExporter }) => new OTLPTraceExporter(),
    ));
  }

  export(spans: ReadableSpan[], callback: Parameters<SpanExporter["export"]>[1]): void {
    void this.get().then(
      (exporter) => exporter.export(spans, callback),
      (error) => callback({ code: 1, error: error instanceof Error ? error : new Error(String(error)) }),
    );
  }

  async forceFlush(): Promise<void> {
    if (this.exporter) await (await this.exporter).forceFlush?.();
  }

  async shutdown(): Promise<void> {
    if (this.exporter) await (await this.exporter).shutdown();
  }
}

export class RunTelemetry {
  private readonly provider: NodeTracerProvider;
  private readonly tracer: Tracer;
  private readonly runs = new Map<string, RunRecord>();
  private readonly finalizations = new Set<Promise<void>>();
  private readonly activeTool = new AsyncLocalStorage<ToolScope>();
  private readonly captureOtlpContent = process.env["FABDESK_OTEL_CAPTURE_CONTENT"] === "1";
  private readonly runDumps: RunDumpSink | undefined;

  constructor(opts: RunTelemetryOptions) {
    this.runDumps = opts.runDumps;
    const endpoint =
      process.env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] ??
      process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
    const processors = endpoint ? [new BatchSpanProcessor(new LazyOtlpExporter())] : [];
    this.provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        "service.name": process.env["OTEL_SERVICE_NAME"] ?? "fabdesk-core",
        "service.version": opts.version,
        "service.instance.id": `${process.pid}-${crypto.randomUUID()}`,
      }),
      spanProcessors: processors,
    });
    // Deliberately do not register globally: Sentry may own the process-wide provider. All Fabdesk
    // parent contexts are passed explicitly, so the two tracing systems can coexist.
    this.tracer = this.provider.getTracer("fabdesk.agent-runs", opts.version);
    if (endpoint) logger.info("OpenTelemetry trace export enabled", { endpoint });
  }

  async startAgentRun(input: {
    runId: string;
    threadId: string;
    agentId: string;
    projectId: string | null;
    cwd: string;
    prompt: string;
    attachments?: Array<{ path: string; mime: string }>;
    model?: string;
  }): Promise<AgentTrace> {
    const runsDir = join(input.cwd, ".fabdesk", "runs");
    const dir = join(runsDir, input.runId);
    const logPath = join(dir, "trace.jsonl");
    await mkdir(dir, { recursive: true });
    void pruneRunDirectories(runsDir, input.runId).catch((error) =>
      logger.warn("could not prune old agent traces", { error: errMsg(error) }),
    );
    const span = this.tracer.startSpan("fabdesk.agent.run", {
      kind: SpanKind.INTERNAL,
      attributes: {
        "fabdesk.run.id": input.runId,
        "fabdesk.thread.id": input.threadId,
        "fabdesk.agent.id": input.agentId,
        ...(input.projectId ? { "fabdesk.project.id": input.projectId } : {}),
        ...(input.model ? { "gen_ai.request.model": input.model } : {}),
        "gen_ai.operation.name": "invoke_agent",
        "fabdesk.trace.path": logPath,
        "fabdesk.prompt.sha256": hashText(input.prompt),
        ...(this.captureOtlpContent ? { "gen_ai.input.messages": clip(input.prompt) } : {}),
      },
    });
    const otelContext = trace.setSpan(ROOT_CONTEXT, span);
    const traceId = span.spanContext().traceId || randomBytes(16).toString("hex");
    const run: RunRecord = {
      runId: input.runId,
      threadId: input.threadId,
      agentId: input.agentId,
      projectId: input.projectId,
      traceId,
      dir,
      logPath,
      span,
      otelContext,
      seq: 0,
      snapshotSeq: 0,
      pending: [],
      flushTimer: null,
      traceBytes: 0,
      traceTruncated: false,
      writes: Promise.resolve(),
      snapshotCache: new Map(),
      blobHashes: new Set(),
      blobBytes: 0,
      snapshotManifestBytes: 0,
      lastSnapshot: null,
      snapshotDirty: true,
      finalization: null,
    };
    this.runs.set(input.runId, run);
    await this.write(run, "run.started", input);
    return {
      logPath,
      record: (type, body) => this.recordAgentEvent(run, type, body),
      finish: (status, details = {}) => this.finalizeAgentRun(run, status, details),
    };
  }

  forToolCall(runId: string): ToolTelemetry | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    return {
      traceToolCall: (input, invoke) => this.traceToolCall(run, input, invoke),
      recordToolEvent: (type, body) => this.recordToolEvent(run, type, body),
    };
  }

  async traceKicadCli(
    input: KicadInvocation,
    invoke: () => Promise<RunResult>,
  ): Promise<RunResult> {
    const scope = this.activeTool.getStore();
    if (!scope) return invoke();
    const span = this.tracer.startSpan(
      "kicad-cli",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "fabdesk.run.id": scope.run.runId,
          "fabdesk.tool.name": scope.tool,
          "process.executable.path": input.command[0] ?? "kicad-cli",
          "process.command_args": input.command,
          "process.working_directory": input.cwd,
        },
      },
      scope.context,
    );
    await this.write(scope.run, "kicad.started", input);
    try {
      const result = await invoke();
      span.setAttributes({
        "process.exit.code": result.exitCode,
        "fabdesk.kicad.stdout.sha256": hashText(result.stdout),
        "fabdesk.kicad.stderr.sha256": hashText(result.stderr),
        ...(this.captureOtlpContent
          ? { "process.stdout": clip(result.stdout), "process.stderr": clip(result.stderr) }
          : {}),
      });
      span.setStatus({ code: result.exitCode === 0 ? SpanStatusCode.OK : SpanStatusCode.ERROR });
      await this.write(scope.run, "kicad.finished", { ...input, ...result });
      return result;
    } catch (error) {
      const result = failedKicadResult(error);
      if (result) {
        span.setAttributes({
          "process.exit.code": result.exitCode,
          "fabdesk.kicad.stdout.sha256": hashText(result.stdout),
          "fabdesk.kicad.stderr.sha256": hashText(result.stderr),
          ...(this.captureOtlpContent
            ? { "process.stdout": clip(result.stdout), "process.stderr": clip(result.stderr) }
            : {}),
        });
      }
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg(error) });
      await this.write(scope.run, "kicad.failed", { ...input, ...(result ?? {}), error });
      throw error;
    } finally {
      span.end();
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.runs.values()].map(
        (run) =>
          run.finalization ??
          this.finalizeAgentRun(run, "aborted", { reason: "telemetry shutdown" }),
      ),
    );
    await Promise.allSettled([...this.finalizations]);
    await this.provider
      .shutdown()
      .catch((error) => logger.warn("OpenTelemetry shutdown failed", { error: errMsg(error) }));
  }

  private async traceToolCall(
    run: RunRecord,
    input: Parameters<ToolTelemetry["traceToolCall"]>[0],
    invoke: () => Promise<ToolOutput>,
  ): Promise<ToolOutput> {
    let snapshot: Awaited<ReturnType<typeof snapshotProject>> | null = null;
    if (input.project) {
      try {
        snapshot = await snapshotProject(run, input.project.dir);
      } catch (error) {
        await this.write(run, "snapshot.failed", {
          tool: input.name,
          projectDir: input.project.dir,
          error,
        });
      }
    }
    const span = this.tracer.startSpan(
      `mcp.${input.name}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          "rpc.system": "mcp",
          "rpc.method": input.name,
          "fabdesk.run.id": run.runId,
          ...(input.sessionId ? { "mcp.session.id": input.sessionId } : {}),
          ...(input.project
            ? { "fabdesk.project.id": input.project.id, "fabdesk.project.path": input.project.dir }
            : {}),
          "fabdesk.tool.arguments.sha256": hashText(input.args),
          ...(snapshot?.manifestPath && snapshot.sha256
            ? {
                "fabdesk.snapshot.path": snapshot.manifestPath,
                "fabdesk.snapshot.sha256": snapshot.sha256,
              }
            : {}),
          ...(this.captureOtlpContent ? { "fabdesk.tool.arguments": clip(input.args) } : {}),
        },
      },
      run.otelContext,
    );
    await this.write(run, "mcp.request", {
      ...input,
      project: input.project
        ? { id: input.project.id, name: input.project.name, dir: input.project.dir }
        : null,
      snapshot,
    });
    const toolContext = trace.setSpan(run.otelContext, span);
    try {
      const output = await this.activeTool.run(
        { run, context: toolContext, tool: input.name },
        invoke,
      );
      span.setAttributes({
        "fabdesk.tool.result.sha256": hashText(output),
        "fabdesk.tool.is_error": output.isError ?? false,
        ...(this.captureOtlpContent ? { "fabdesk.tool.result": clip(output) } : {}),
      });
      span.setStatus({ code: output.isError ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      await this.write(run, "mcp.result", { name: input.name, output });
      return output;
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg(error) });
      await this.write(run, "mcp.error", { name: input.name, error });
      throw error;
    } finally {
      if (input.project && !input.readOnly) run.snapshotDirty = true;
      span.end();
    }
  }

  private recordAgentEvent(run: RunRecord, type: string, body: unknown): void {
    try {
      run.span.addEvent(
        type,
        this.captureOtlpContent ? { "fabdesk.event.body": clip(body) } : undefined,
      );
    } catch (error) {
      logger.warn("could not add agent span event", { runId: run.runId, error: errMsg(error) });
    }
    this.buffer(run, type, body);
  }

  private recordToolEvent(run: RunRecord, type: string, body: unknown): void {
    try {
      const scope = this.activeTool.getStore();
      if (scope?.run === run)
        trace
          .getSpan(scope.context)
          ?.addEvent(
            type,
            this.captureOtlpContent ? { "fabdesk.event.body": clip(body) } : undefined,
          );
    } catch (error) {
      logger.warn("could not add tool span event", { runId: run.runId, error: errMsg(error) });
    }
    this.buffer(run, type, body);
  }

  private finalizeAgentRun(
    run: RunRecord,
    status: "completed" | "aborted" | "failed",
    details: Record<string, unknown>,
  ): Promise<void> {
    if (run.finalization) return run.finalization;
    const finalization = this.finishAgentRun(run, status, details);
    run.finalization = finalization;
    this.finalizations.add(finalization);
    void finalization.then(
      () => this.finalizations.delete(finalization),
      () => this.finalizations.delete(finalization),
    );
    return finalization;
  }

  private async finishAgentRun(
    run: RunRecord,
    status: "completed" | "aborted" | "failed",
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.write(run, "run.finished", { status, ...details });
    await createLlmDump(run, this.runDumps).catch((error) =>
      logger.warn("could not persist LLM run dump", { runId: run.runId, error: errMsg(error) }),
    );
    run.span.setStatus({
      code: status === "completed" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      message: status,
    });
    run.span.setAttribute("fabdesk.run.status", status);
    run.span.end();
    this.runs.delete(run.runId);
  }

  private enqueue(run: RunRecord, type: string, body: unknown): void {
    run.pending.push({
      schema: 1,
      traceId: run.traceId,
      runId: run.runId,
      seq: run.seq++,
      timeUnixNano: unixNano(),
      type,
      body,
    });
  }

  private buffer(run: RunRecord, type: string, body: unknown): void {
    this.enqueue(run, type, body);
    if (run.flushTimer) return;
    run.flushTimer = setTimeout(() => {
      run.flushTimer = null;
      void this.flush(run);
    }, 20);
  }

  private write(run: RunRecord, type: string, body: unknown): Promise<void> {
    this.enqueue(run, type, body);
    return this.flush(run);
  }

  private flush(run: RunRecord): Promise<void> {
    if (run.flushTimer) {
      clearTimeout(run.flushTimer);
      run.flushTimer = null;
    }
    const records = run.pending.splice(0);
    if (!records.length) return run.writes;
    run.writes = run.writes
      .then(async () => {
        const lines: string[] = [];
        for (const record of records) {
          const line = boundedTraceLine(run, record);
          if (line) lines.push(line);
        }
        if (lines.length)
          await appendFile(run.logPath, lines.join(""), { encoding: "utf8", mode: 0o600 });
      })
      .catch((error) =>
        logger.warn("could not persist agent trace", { runId: run.runId, error: errMsg(error) }),
      );
    return run.writes;
  }
}

function boundedTraceLine(run: RunRecord, record: TraceRecord): string | null {
  if (run.traceTruncated) return null;
  let line: string;
  try {
    line = json(record) + "\n";
  } catch (error) {
    line =
      json({
        ...record,
        body: { omitted: "serialization-error", error: errMsg(error) },
      }) + "\n";
  }
  let bytes = Buffer.byteLength(line);
  if (bytes > RUN_TELEMETRY_LIMITS.eventBytes) {
    line =
      json({
        ...record,
        body: { omitted: "event-over-limit", originalBytes: bytes },
      }) + "\n";
    bytes = Buffer.byteLength(line);
  }
  if (run.traceBytes + bytes > RUN_TELEMETRY_LIMITS.traceBytes) {
    run.traceTruncated = true;
    const notice =
      json({
        ...record,
        type: "telemetry.truncated",
        body: {
          omitted: "trace-budget-exhausted",
          droppedType: record.type,
          limitBytes: RUN_TELEMETRY_LIMITS.traceBytes,
        },
      }) + "\n";
    run.traceBytes += Buffer.byteLength(notice);
    return notice;
  }
  run.traceBytes += bytes;
  return line;
}

type SnapshotManifest = {
  schema: 1;
  projectDir: string;
  capturedAtUnixNano: string;
  entries: SnapshotEntry[];
  omissions: string[];
};

type DumpBlob =
  | { encoding: "utf8"; content: string }
  | {
      encoding: "omitted";
      size: number;
      reason: "binary" | "over-limit" | "missing" | "dump-budget";
    };

async function createLlmDump(run: RunRecord, sink: RunDumpSink | undefined): Promise<void> {
  const events = (await readFile(run.logPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
  const snapshotsDir = join(run.dir, "snapshots");
  const names = await readdir(snapshotsDir).catch(() => [] as string[]);
  const snapshots: SnapshotManifest[] = [];
  for (const name of names.filter((value) => /^\d+\.json$/.test(value)).sort()) {
    snapshots.push(
      JSON.parse(await readFile(join(snapshotsDir, name), "utf8")) as SnapshotManifest,
    );
  }
  const files = new Map<string, SnapshotEntry>();
  for (const snapshot of snapshots) {
    for (const entry of snapshot.entries)
      if (entry.kind === "file" && entry.sha256 && !files.has(entry.sha256))
        files.set(entry.sha256, entry);
  }
  const blobs: Record<string, DumpBlob> = {};
  let embeddedBlobBytes = 0;
  for (const [sha256, entry] of files) {
    if (entry.size > RUN_TELEMETRY_LIMITS.snapshotFileBytes) {
      blobs[sha256] = { encoding: "omitted", size: entry.size, reason: "over-limit" };
      continue;
    }
    const bytes = await readFile(join(snapshotsDir, "blobs", sha256)).catch(() => null);
    if (!bytes) {
      blobs[sha256] = { encoding: "omitted", size: entry.size, reason: "missing" };
      continue;
    }
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (content.includes("\0")) {
        blobs[sha256] = { encoding: "omitted", size: entry.size, reason: "binary" };
      } else if (embeddedBlobBytes + bytes.byteLength > RUN_TELEMETRY_LIMITS.dumpBlobBytes) {
        blobs[sha256] = { encoding: "omitted", size: entry.size, reason: "dump-budget" };
      } else {
        blobs[sha256] = { encoding: "utf8", content };
        embeddedBlobBytes += bytes.byteLength;
      }
    } catch {
      blobs[sha256] = { encoding: "omitted", size: entry.size, reason: "binary" };
    }
  }
  const createdAtUnixNano = unixNano();
  const dump = {
    schema: "fabdesk.llm-run-dump/v1",
    runId: run.runId,
    traceId: run.traceId,
    threadId: run.threadId,
    agentId: run.agentId,
    projectId: run.projectId,
    createdAtUnixNano,
    instructions:
      "Analyze the ordered events, compare each MCP request with its preceding project snapshot, and identify where the agent's model of the KiCad project diverged from the recorded files or CLI results.",
    events,
    snapshots,
    blobs,
    limits: RUN_TELEMETRY_LIMITS,
  };
  let dumpText = json(dump) + "\n";
  if (Buffer.byteLength(dumpText) > RUN_TELEMETRY_LIMITS.dumpBytes) {
    dumpText =
      json({
        ...dump,
        snapshots: [],
        blobs: {},
        omissions: [
          "Snapshot manifests and embedded files exceeded the total dump budget; use the project-local snapshots directory.",
        ],
      }) + "\n";
  }
  await writeFile(join(run.dir, "llm-dump.json"), dumpText, {
    encoding: "utf8",
    mode: 0o600,
  });
  await sink?.put({
    runId: run.runId,
    traceId: run.traceId,
    threadId: run.threadId,
    agentId: run.agentId,
    projectId: run.projectId,
    createdAt: new Date(Number(BigInt(createdAtUnixNano) / NS_PER_MS)).toISOString(),
    dumpJson: dumpText,
  });
}

function failedKicadResult(error: unknown): RunResult | null {
  if (!error || typeof error !== "object" || !("result" in error)) return null;
  const result = error.result;
  if (!result || typeof result !== "object") return null;
  const value = result as Partial<RunResult>;
  return typeof value.stdout === "string" &&
    typeof value.stderr === "string" &&
    typeof value.exitCode === "number"
    ? { stdout: value.stdout, stderr: value.stderr, exitCode: value.exitCode }
    : null;
}

type SnapshotEntry = {
  path: string;
  kind: "file" | "symlink";
  size: number;
  mtimeNs: string;
  sha256: string | null;
  blob?: string;
  target?: string;
  omitted?: "file-over-limit" | "run-blob-budget";
};

type SnapshotCacheEntry = { signature: string; entry: SnapshotEntry };
type SnapshotResult = {
  manifestPath?: string;
  sha256?: string;
  files: number;
  reusedFiles: number;
  reused?: boolean;
  omitted?: "snapshot-limit" | "manifest-budget";
};

async function snapshotProject(
  run: RunRecord,
  projectDir: string,
): Promise<SnapshotResult> {
  if (!run.snapshotDirty && run.lastSnapshot)
    return { ...run.lastSnapshot.result, reusedFiles: run.lastSnapshot.result.files, reused: true };
  if (run.snapshotSeq >= RUN_TELEMETRY_LIMITS.snapshots)
    return { files: 0, reusedFiles: 0, omitted: "snapshot-limit" };
  const snapshotsDir = join(run.dir, "snapshots");
  const blobsDir = join(snapshotsDir, "blobs");
  await mkdir(blobsDir, { recursive: true });
  const entries: SnapshotEntry[] = [];
  const nextCache = new Map<string, SnapshotCacheEntry>();
  let reusedFiles = 0;
  let hitFileLimit = false;
  await walk(projectDir, "", async (absolute, path) => {
    if (entries.length >= RUN_TELEMETRY_LIMITS.snapshotFiles) {
      hitFileLimit = true;
      return false;
    }
    const st = await lstat(absolute, { bigint: true });
    const signature = `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
    const cached = run.snapshotCache.get(path);
    if (cached?.signature === signature) {
      entries.push(cached.entry);
      nextCache.set(path, cached);
      reusedFiles++;
      return true;
    }
    if (st.isSymbolicLink()) {
      const target = await readlink(absolute);
      const entry: SnapshotEntry = {
        path,
        kind: "symlink",
        size: Number(st.size),
        mtimeNs: st.mtimeNs.toString(),
        sha256: createHash("sha256").update(`symlink:${target}`).digest("hex"),
        target,
      };
      entries.push(entry);
      nextCache.set(path, { signature, entry });
      return true;
    }
    if (!st.isFile()) return true;
    const size = Number(st.size);
    if (size > RUN_TELEMETRY_LIMITS.snapshotFileBytes) {
      const entry: SnapshotEntry = {
        path,
        kind: "file",
        size,
        mtimeNs: st.mtimeNs.toString(),
        sha256: null,
        omitted: "file-over-limit",
      };
      entries.push(entry);
      nextCache.set(path, { signature, entry });
      return true;
    }
    const bytes = await readFile(absolute);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      !run.blobHashes.has(sha256) &&
      run.blobBytes + bytes.byteLength > RUN_TELEMETRY_LIMITS.snapshotBlobBytes
    ) {
      const entry: SnapshotEntry = {
        path,
        kind: "file",
        size,
        mtimeNs: st.mtimeNs.toString(),
        sha256,
        omitted: "run-blob-budget",
      };
      entries.push(entry);
      nextCache.set(path, { signature, entry });
      return true;
    }
    const blob = join("blobs", sha256);
    const blobPath = join(blobsDir, sha256);
    await writeFile(blobPath, bytes, { flag: "wx", mode: 0o600 }).catch(
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    if (!run.blobHashes.has(sha256)) {
      run.blobHashes.add(sha256);
      run.blobBytes += bytes.byteLength;
    }
    const entry: SnapshotEntry = {
      path,
      kind: "file",
      size,
      mtimeNs: st.mtimeNs.toString(),
      sha256,
      blob,
    };
    entries.push(entry);
    nextCache.set(path, { signature, entry });
    return true;
  });
  run.snapshotCache = nextCache;
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const stateSha256 = createHash("sha256").update(json(entries)).digest("hex");
  if (run.lastSnapshot?.stateSha256 === stateSha256) {
    run.snapshotDirty = false;
    return { ...run.lastSnapshot.result, reusedFiles, reused: true };
  }
  const manifest: SnapshotManifest = {
    schema: 1,
    projectDir,
    capturedAtUnixNano: unixNano(),
    entries,
    omissions: hitFileLimit
      ? [`file count exceeded ${RUN_TELEMETRY_LIMITS.snapshotFiles}`]
      : [],
  };
  const manifestText = json(manifest) + "\n";
  const manifestBytes = Buffer.byteLength(manifestText);
  if (
    manifestBytes > RUN_TELEMETRY_LIMITS.snapshotManifestBytes ||
    run.snapshotManifestBytes + manifestBytes > RUN_TELEMETRY_LIMITS.snapshotManifestBytes
  )
    return { files: entries.length, reusedFiles, omitted: "manifest-budget" };
  const snapshotNo = String(run.snapshotSeq++).padStart(6, "0");
  const manifestPath = join(snapshotsDir, `${snapshotNo}.json`);
  await writeFile(manifestPath, manifestText, { encoding: "utf8", mode: 0o600 });
  run.snapshotManifestBytes += manifestBytes;
  const result: SnapshotResult = {
    manifestPath,
    sha256: createHash("sha256").update(manifestText).digest("hex"),
    files: entries.length,
    reusedFiles,
  };
  run.lastSnapshot = { stateSha256, result };
  run.snapshotDirty = false;
  return result;
}

async function walk(
  root: string,
  path: string,
  visit: (absolute: string, path: string) => Promise<boolean>,
): Promise<boolean> {
  const absolute = join(root, path);
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries) {
    if (!path && (entry.name === ".git" || entry.name === ".fabdesk")) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      if (!(await walk(root, child, visit))) return false;
    } else if (!(await visit(join(root, child), relative(root, join(root, child))))) return false;
  }
  return true;
}

async function pruneRunDirectories(runsDir: string, currentRunId: string): Promise<void> {
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of await readdir(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === currentRunId) continue;
    const path = join(runsDir, entry.name);
    candidates.push({ path, mtimeMs: Number((await lstat(path, { bigint: true })).mtimeMs) });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of candidates.slice(RUN_TELEMETRY_LIMITS.localRuns - 1))
    await rm(stale.path, { recursive: true, force: true });
}
