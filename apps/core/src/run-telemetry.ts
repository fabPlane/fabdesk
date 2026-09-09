/** OpenTelemetry spans plus an exact, local JSONL bundle for agent-run debugging. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
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
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { ToolOutput, ToolTelemetry } from "@fabdesk/tools";
import type { KicadInvocation, RunResult } from "@fabdesk/kicad";
import { errMsg, logger } from "./log";

type RunRecord = {
  runId: string;
  traceId: string;
  dir: string;
  logPath: string;
  span: Span;
  otelContext: Context;
  seq: number;
  snapshotSeq: number;
  writes: Promise<void>;
};

type ToolScope = { run: RunRecord; context: Context; tool: string };

export type AgentTrace = {
  logPath: string;
  record(type: string, body: unknown): Promise<void>;
  finish(
    status: "completed" | "aborted" | "failed",
    details?: Record<string, unknown>,
  ): Promise<void>;
};

export type RunTelemetryOptions = { version: string };

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

export class RunTelemetry {
  private readonly provider: NodeTracerProvider;
  private readonly tracer: Tracer;
  private readonly runs = new Map<string, RunRecord>();
  private readonly activeTool = new AsyncLocalStorage<ToolScope>();
  private readonly captureOtlpContent = process.env["FABDESK_OTEL_CAPTURE_CONTENT"] === "1";

  constructor(opts: RunTelemetryOptions) {
    const endpoint =
      process.env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] ??
      process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
    const processors = endpoint ? [new BatchSpanProcessor(new OTLPTraceExporter())] : [];
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
    const dir = join(input.cwd, ".fabdesk", "runs", input.runId);
    const logPath = join(dir, "trace.jsonl");
    await mkdir(dir, { recursive: true });
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
      traceId,
      dir,
      logPath,
      span,
      otelContext,
      seq: 0,
      snapshotSeq: 0,
      writes: Promise.resolve(),
    };
    this.runs.set(input.runId, run);
    await this.write(run, "run.started", input);
    return {
      logPath,
      record: (type, body) => this.recordAgentEvent(run, type, body),
      finish: (status, details = {}) => this.finishAgentRun(run, status, details),
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
    await Promise.all([...this.runs.values()].map((run) => run.writes));
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
          ...(snapshot
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
      span.end();
    }
  }

  private async recordAgentEvent(run: RunRecord, type: string, body: unknown): Promise<void> {
    run.span.addEvent(type, {
      "fabdesk.event.body.sha256": hashText(body),
      ...(this.captureOtlpContent ? { "fabdesk.event.body": clip(body) } : {}),
    });
    await this.write(run, type, body);
  }

  private recordToolEvent(run: RunRecord, type: string, body: unknown): void {
    const scope = this.activeTool.getStore();
    if (scope?.run === run)
      trace.getSpan(scope.context)?.addEvent(type, {
        "fabdesk.event.body.sha256": hashText(body),
        ...(this.captureOtlpContent ? { "fabdesk.event.body": clip(body) } : {}),
      });
    void this.write(run, type, body);
  }

  private async finishAgentRun(
    run: RunRecord,
    status: "completed" | "aborted" | "failed",
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.write(run, "run.finished", { status, ...details });
    run.span.setStatus({
      code: status === "completed" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      message: status,
    });
    run.span.setAttribute("fabdesk.run.status", status);
    run.span.end();
    this.runs.delete(run.runId);
  }

  private write(run: RunRecord, type: string, body: unknown): Promise<void> {
    run.writes = run.writes
      .then(async () => {
        const record = {
          schema: 1,
          traceId: run.traceId,
          runId: run.runId,
          seq: run.seq++,
          timeUnixNano: unixNano(),
          type,
          body,
        };
        await appendFile(run.logPath, json(record) + "\n", { encoding: "utf8", mode: 0o600 });
      })
      .catch((error) =>
        logger.warn("could not persist agent trace", { runId: run.runId, error: errMsg(error) }),
      );
    return run.writes;
  }
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
  sha256: string;
  blob?: string;
  target?: string;
};

async function snapshotProject(
  run: RunRecord,
  projectDir: string,
): Promise<{ manifestPath: string; sha256: string; files: number }> {
  const snapshotNo = String(run.snapshotSeq++).padStart(6, "0");
  const snapshotsDir = join(run.dir, "snapshots");
  const blobsDir = join(snapshotsDir, "blobs");
  await mkdir(blobsDir, { recursive: true });
  const entries: SnapshotEntry[] = [];
  await walk(projectDir, "", async (absolute, path) => {
    const st = await lstat(absolute, { bigint: true });
    if (st.isSymbolicLink()) {
      const target = await readlink(absolute);
      entries.push({
        path,
        kind: "symlink",
        size: Number(st.size),
        mtimeNs: st.mtimeNs.toString(),
        sha256: createHash("sha256").update(`symlink:${target}`).digest("hex"),
        target,
      });
      return;
    }
    if (!st.isFile()) return;
    const bytes = await readFile(absolute);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const blob = join("blobs", sha256);
    const blobPath = join(blobsDir, sha256);
    await writeFile(blobPath, bytes, { flag: "wx", mode: 0o600 }).catch(
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    entries.push({
      path,
      kind: "file",
      size: Number(st.size),
      mtimeNs: st.mtimeNs.toString(),
      sha256,
      blob,
    });
  });
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = { schema: 1, projectDir, capturedAtUnixNano: unixNano(), entries };
  const manifestText = json(manifest) + "\n";
  const manifestPath = join(snapshotsDir, `${snapshotNo}.json`);
  await writeFile(manifestPath, manifestText, { encoding: "utf8", mode: 0o600 });
  return {
    manifestPath,
    sha256: createHash("sha256").update(manifestText).digest("hex"),
    files: entries.length,
  };
}

async function walk(
  root: string,
  path: string,
  visit: (absolute: string, path: string) => Promise<void>,
): Promise<void> {
  const absolute = join(root, path);
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries) {
    if (!path && (entry.name === ".git" || entry.name === ".fabdesk")) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) await walk(root, child, visit);
    else await visit(join(root, child), relative(root, join(root, child)));
  }
}
