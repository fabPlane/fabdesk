/** Full disk-backed run capture; OTLP remains a separate metadata-oriented export. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, copyFile, link, lstat, mkdir, open, readFile, readdir, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { INLINE_DUMP_BYTES, fileDumpReference } from "./run-dump-file";
import type { RunCapture } from "./run-retention";
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
import type { BuildInfo } from "./build-info";
import { errMsg, logger } from "./log";

type RunRecord = {
  runId: string;
  threadId: string;
  agentId: string;
  projectId: string | null;
  traceId: string;
  dir: string;
  projectDir: string | null;
  logPath: string;
  span: Span;
  otelContext: Context;
  seq: number;
  snapshotSeq: number;
  pending: TraceRecord[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  traceBytes: number;
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
  begin?(runId: string, capture?: RunCapture): void;
  end?(runId: string): void;
  put(dump: {
    runId: string;
    traceId: string;
    threadId: string;
    agentId: string;
    projectId: string | null;
    createdAt: string;
    dumpJson: string;
    runDirectory?: string;
  }): void | Promise<void>;
};

/** `build` is written on every `run.started` so usage analysis can tell builds apart. */
export type RunTelemetryOptions = { version: string; build?: BuildInfo; runDumps?: RunDumpSink; dumpDirectory?: string };

/** Transport/memory windows, never capture/discard budgets. */
export const RUN_TELEMETRY_LIMITS = { capture: "full", localRuns: 50 } as const;
const INLINE_TEXT_BYTES = 1024 * 1024;

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
  private readonly build: BuildInfo | undefined;
  private readonly dumpDirectory: string | undefined;

  constructor(opts: RunTelemetryOptions) {
    this.runDumps = opts.runDumps;
    this.build = opts.build;
    this.dumpDirectory = opts.dumpDirectory;
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
    this.runDumps?.begin?.(input.runId, { createdAt: new Date().toISOString(), runDirectory: dir });
    try { await mkdir(dir, { recursive: true }); }
    catch (error) { this.runDumps?.end?.(input.runId); throw error; }
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
      projectDir: input.projectId ? input.cwd : null,
      logPath,
      span,
      otelContext,
      seq: 0,
      snapshotSeq: 0,
      pending: [],
      flushTimer: null,
      traceBytes: 0,
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
    await this.write(run, "run.started", this.build ? { ...input, build: this.build } : input);
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
    if (type === "agent.tool_result") run.snapshotDirty = true;
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
    if (run.projectDir) {
      run.snapshotDirty = true;
      try { await this.write(run, "snapshot.final", await snapshotProject(run, run.projectDir)); }
      catch (error) { await this.write(run, "snapshot.failed", { phase: "final", error }); }
    }
    await this.write(run, "run.finished", { status, ...details });
    await createLlmDump(run, this.runDumps, this.dumpDirectory).catch((error) =>
      logger.warn("could not persist LLM run dump", { runId: run.runId, error: errMsg(error) }),
    );
    run.span.setStatus({
      code: status === "completed" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      message: status,
    });
    run.span.setAttribute("fabdesk.run.status", status);
    run.span.end();
    this.runs.delete(run.runId);
    this.runDumps?.end?.(run.runId);
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
        for (const record of records)
          await appendFile(run.logPath, completeTraceLine(run, record), { encoding: "utf8", mode: 0o600 });
      })
      .catch((error) =>
        logger.warn("could not persist agent trace", { runId: run.runId, error: errMsg(error) }),
      );
    return run.writes;
  }
}

function completeTraceLine(run: RunRecord, record: TraceRecord): string {
  let line: string;
  try {
    line = json(record) + "\n";
  } catch (error) {
    line = json({ ...record, body: { omitted: "serialization-error", error: errMsg(error) } }) + "\n";
  }
  run.traceBytes += Buffer.byteLength(line);
  return line;
}

type SnapshotManifest = {
  schema: 1;
  projectDir: string;
  capturedAtUnixNano: string;
  entries: SnapshotEntry[];
  omissions: string[];
};

/** Stream a complete portable JSON dump; never load the entire run/files into RAM. */
async function createLlmDump(run: RunRecord, sink: RunDumpSink | undefined, dumpDirectory?: string): Promise<void> {
  const createdAtUnixNano = unixNano();
  const header = {
    schema: "fabdesk.llm-run-dump/v1", runId: run.runId, traceId: run.traceId,
    threadId: run.threadId, agentId: run.agentId, projectId: run.projectId, createdAtUnixNano,
    instructions: "Analyze ordered events, preceding project snapshots and CLI results. Decode base64 blobs to restore exact original bytes. Capture errors are explicit; size alone never omits data.",
    limits: RUN_TELEMETRY_LIMITS,
  };
  const path = join(run.dir, "llm-dump.json");
  const temporary = `${path}.part`;
  const file = await open(temporary, "w", 0o600);
  let buffered = "";
  const emit = async (text: string) => {
    buffered += text;
    if (Buffer.byteLength(buffered) >= 1024 * 1024) { await file.writeFile(buffered); buffered = ""; }
  };
  try {
    await emit(json(header).slice(0, -1) + ',"events":[');
    let separator = "";
    for await (const line of createInterface({ input: createReadStream(run.logPath), crlfDelay: Infinity })) {
      if (!line) continue;
      await emit(separator + line); separator = ",";
    }
    await emit('],"snapshots":[');
    const snapshotsDir = join(run.dir, "snapshots");
    const names = await readdir(snapshotsDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    const hashes = new Set<string>();
    separator = "";
    for (const name of names.filter((value) => /^\d+\.json$/.test(value)).sort()) {
      const text = await readFile(join(snapshotsDir, name), "utf8");
      const snapshot = JSON.parse(text) as SnapshotManifest;
      for (const entry of snapshot.entries) if (entry.kind === "file" && entry.sha256) hashes.add(entry.sha256);
      await emit(separator + text.trimEnd()); separator = ",";
    }
    await emit('],"blobs":{'); separator = "";
    for (const sha256 of hashes) {
      const blobPath = join(snapshotsDir, "blobs", sha256);
      const info = await stat(blobPath);
      let text: string | null = null;
      if (info.size <= INLINE_TEXT_BYTES) {
        try {
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(blobPath));
          if (!decoded.includes("\0")) text = decoded;
        } catch { /* arbitrary bytes are streamed losslessly as base64 below */ }
      }
      await emit(separator + json(sha256) + ":"); separator = ",";
      if (text !== null) await emit(json({ encoding: "utf8", content: text }));
      else {
        await emit('{"encoding":"base64","content":"');
        let carry = Buffer.alloc(0);
        for await (const chunk of createReadStream(blobPath)) {
          const bytes = Buffer.concat([carry, chunk as Buffer]);
          const end = bytes.length - bytes.length % 3;
          await emit(bytes.subarray(0, end).toString("base64"));
          carry = bytes.subarray(end);
        }
        if (carry.length) await emit(carry.toString("base64"));
        await emit('"}');
      }
    }
    await emit("}}\n");
    if (buffered) await file.writeFile(buffered);
    await file.sync();
  } finally { await file.close(); }
  await rename(temporary, path);
  const size = (await stat(path)).size;
  let durablePath = path;
  if (size > INLINE_DUMP_BYTES && dumpDirectory) {
    await mkdir(dumpDirectory, { recursive: true });
    durablePath = join(dumpDirectory, `${run.runId}.json`);
    const pending = `${durablePath}.${crypto.randomUUID()}.part`;
    try {
      // Stable profile storage survives a project move/purge; hard links avoid duplicate disk usage.
      await link(path, pending).catch(() => copyFile(path, pending));
      await rename(pending, durablePath);
    } finally { await rm(pending, { force: true }); }
  }
  const dumpJson = size <= INLINE_DUMP_BYTES ? await readFile(path, "utf8") : await fileDumpReference(durablePath);
  await sink?.put({ runId: run.runId, traceId: run.traceId, threadId: run.threadId,
    agentId: run.agentId, projectId: run.projectId,
    createdAt: new Date(Number(BigInt(createdAtUnixNano) / NS_PER_MS)).toISOString(), dumpJson, runDirectory: run.dir });
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
  error?: string;
  size: number;
  mtimeNs: string;
  sha256: string | null;
  blob?: string;
  target?: string;
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
  const snapshotsDir = join(run.dir, "snapshots");
  const blobsDir = join(snapshotsDir, "blobs");
  await mkdir(blobsDir, { recursive: true });
  const entries: SnapshotEntry[] = [];
  const nextCache = new Map<string, SnapshotCacheEntry>();
  let reusedFiles = 0;
  await walk(projectDir, "", async (absolute, path) => {
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
    const captured = await captureSnapshotFile(absolute, path, blobsDir);
    const entry = captured.entry;
    entries.push(entry);
    if (entry.sha256) {
      if (!run.blobHashes.has(entry.sha256)) {
        run.blobHashes.add(entry.sha256); run.blobBytes += entry.size;
      }
      nextCache.set(path, { signature: captured.signature, entry });
    }
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
    omissions: [],
  };
  const manifestText = json(manifest) + "\n";
  const manifestBytes = Buffer.byteLength(manifestText);
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

/** Retry a changing file once. A second change is a manifest entry, not a failed snapshot. */
export async function captureSnapshotFile(absolute: string, path: string, blobsDir: string,
  copy: (source: string, temporary: string) => Promise<string> = async (source, temporary) => {
    const hash = createHash("sha256");
    await pipeline(createReadStream(source), new Transform({
      transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(null, chunk); },
    }), createWriteStream(temporary, { mode: 0o600, flags: "wx" }));
    return hash.digest("hex");
  },
): Promise<{entry: SnapshotEntry; signature: string}> {
  let lastSize = 0, lastMtime = "0", signature = "";
  const failure = () => ({ signature, entry: { path, kind: "file" as const, size: lastSize,
    mtimeNs: lastMtime, sha256: null, error: "project file changed during snapshot after retry" } });
  for (let attempt = 0; ; attempt++) {
    const temporary = join(blobsDir, `.capture-${crypto.randomUUID()}`);
    try {
      const before = await lstat(absolute, { bigint: true });
      signature = `${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}:${before.ctimeNs}`;
      lastSize = Number(before.size); lastMtime = before.mtimeNs.toString();
      if (!before.isFile()) { if (attempt === 0) continue; return failure(); }
      const sha256 = await copy(absolute, temporary);
      const after = await lstat(absolute, { bigint: true });
      if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}` !== signature) {
        lastSize = Number(after.size); lastMtime = after.mtimeNs.toString();
        if (attempt === 0) continue;
        return failure();
      }
      const blob = join("blobs", sha256);
      await rename(temporary, join(blobsDir, sha256));
      return { signature, entry: { path, kind: "file", size: Number(before.size),
        mtimeNs: before.mtimeNs.toString(), sha256, blob } };
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      if (attempt === 1) return failure();
    } finally { await rm(temporary, { force: true }); }
  }
}
