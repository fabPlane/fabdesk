import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectHandle } from "@fabdesk/tools";
import { Store, openDatabase } from "../src/db";
import { RUN_TELEMETRY_LIMITS, RunTelemetry } from "../src/run-telemetry";

describe("agent run telemetry", () => {
  test("persists ordered MCP/KiCad events and a content-addressed pre-tool snapshot", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "fabdesk-telemetry-"));
    await mkdir(join(projectDir, "reports"));
    await writeFile(join(projectDir, "circuit.netlist.json"), '{"before":true}\n');
    await writeFile(join(projectDir, "reports", "drc.json"), '{"errors":0}\n');
    const project = {
      id: "prj_1",
      name: "Trace test",
      dir: projectDir,
      manifest: () => ({}) as ReturnType<ProjectHandle["manifest"]>,
      updateManifest: async () => ({}) as Awaited<ReturnType<ProjectHandle["updateManifest"]>>,
    } satisfies ProjectHandle;

    const build = { version: "test", kind: "dev", label: null, commit: "abc1234", branch: "main", dirty: false, channel: "public", builtAt: null } as const;
    const telemetry = new RunTelemetry({ version: "test", build });
    const agent = await telemetry.startAgentRun({
      runId: "run_1",
      threadId: "thread_1",
      agentId: "codex",
      projectId: project.id,
      cwd: projectDir,
      prompt: "inspect the board",
    });
    agent.record("agent.text", { delta: "checking" });
    const tool = telemetry.forToolCall("run_1")!;
    const output = await tool.traceToolCall(
      { name: "verify_drc", args: { project: project.id }, project, readOnly: false, sessionId: "mcp_1" },
      async () => {
        await writeFile(join(projectDir, "circuit.netlist.json"), '{"after":true}\n');
        const cli = await telemetry.traceKicadCli(
          { command: ["/mock/kicad-cli", "pcb", "drc"], cwd: projectDir },
          async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
        );
        return { text: cli.stdout, json: { pass: true } };
      },
    );
    expect(output.text).toBe("ok");
    await agent.finish("completed");
    await telemetry.shutdown();

    const records = (await readFile(agent.logPath, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            seq: number;
            timeUnixNano: string;
            type: string;
            body: Record<string, unknown>;
          },
      );
    expect(records.map((record) => record.type)).toEqual([
      "run.started",
      "agent.text",
      "mcp.request",
      "kicad.started",
      "kicad.finished",
      "mcp.result",
      "run.finished",
    ]);
    expect(records.map((record) => record.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(records[0]!.body["build"]).toEqual(build);
    expect(
      records.every(
        (record, index) =>
          index === 0 || BigInt(record.timeUnixNano) >= BigInt(records[index - 1]!.timeUnixNano),
      ),
    ).toBe(true);

    const request = records.find((record) => record.type === "mcp.request")!;
    const snapshot = request.body["snapshot"] as { manifestPath: string };
    const manifest = JSON.parse(await readFile(snapshot.manifestPath, "utf8")) as {
      entries: Array<{ path: string; blob: string; sha256: string }>;
    };
    const source = manifest.entries.find((entry) => entry.path === "circuit.netlist.json")!;
    expect(
      await readFile(
        join(projectDir, ".fabdesk", "runs", "run_1", "snapshots", source.blob),
        "utf8",
      ),
    ).toBe('{"before":true}\n');
    const dump = JSON.parse(
      await readFile(join(projectDir, ".fabdesk", "runs", "run_1", "llm-dump.json"), "utf8"),
    ) as {
      schema: string;
      events: Array<{ type: string }>;
      blobs: Record<string, { encoding: string; content?: string }>;
    };
    expect(dump.schema).toBe("fabdesk.llm-run-dump/v1");
    expect(dump.events.map((event) => event.type)).toEqual(records.map((record) => record.type));
    expect(dump.blobs[source.sha256]).toEqual({ encoding: "utf8", content: '{"before":true}\n' });
  });

  test("exports OTLP/HTTP protobuf when an endpoint is configured", async () => {
    const savedEndpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
    const savedTraceEndpoint = process.env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"];
    let request: { path: string; contentType: string | null; bytes: number } | null = null;
    const collector = Bun.serve({
      port: 0,
      async fetch(req) {
        request = {
          path: new URL(req.url).pathname,
          contentType: req.headers.get("content-type"),
          bytes: (await req.arrayBuffer()).byteLength,
        };
        return new Response(null, { status: 200 });
      },
    });
    try {
      delete process.env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"];
      process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = `http://127.0.0.1:${collector.port}`;
      const dir = await mkdtemp(join(tmpdir(), "fabdesk-otlp-"));
      const telemetry = new RunTelemetry({ version: "test" });
      const run = await telemetry.startAgentRun({
        runId: "run_export",
        threadId: "thread_1",
        agentId: "codex",
        projectId: null,
        cwd: dir,
        prompt: "test",
      });
      await run.finish("completed");
      await telemetry.shutdown();
      expect(request).toEqual({
        path: "/v1/traces",
        contentType: "application/x-protobuf",
        bytes: expect.any(Number),
      });
      expect(request!.bytes).toBeGreaterThan(0);
    } finally {
      collector.stop(true);
      if (savedEndpoint === undefined) delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];
      else process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] = savedEndpoint;
      if (savedTraceEndpoint === undefined)
        delete process.env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"];
      else process.env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] = savedTraceEndpoint;
    }
  });

  test("stores the complete LLM dump in Fabdesk's SQLite database", async () => {
    const store = new Store(openDatabase(":memory:"));
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-sqlite-dump-"));
    const telemetry = new RunTelemetry({ version: "test", runDumps: store.runDumps });
    const run = await telemetry.startAgentRun({
      runId: "run_shared",
      threadId: "thread_1",
      agentId: "claude",
      projectId: "project_1",
      cwd: dir,
      prompt: "test",
    });
    await run.finish("completed");
    await telemetry.shutdown();

    const row = store.runDumps.get("run_shared")!;
    expect(row).toMatchObject({
      runId: "run_shared",
      threadId: "thread_1",
      agentId: "claude",
      projectId: "project_1",
    });
    expect(JSON.parse(row.dumpJson)).toMatchObject({
      schema: "fabdesk.llm-run-dump/v1",
      agentId: "claude",
      projectId: "project_1",
    });
    store.close();
  });

  test("reuses unchanged snapshots and omits oversized files without reading them", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "fabdesk-incremental-snapshot-"));
    await writeFile(join(projectDir, "board.kicad_pcb"), "board");
    const oversized = join(projectDir, "large.bin");
    await writeFile(oversized, "");
    await truncate(oversized, RUN_TELEMETRY_LIMITS.snapshotFileBytes + 1);
    const project = {
      id: "project_incremental",
      name: "Incremental",
      dir: projectDir,
      manifest: () => ({}) as ReturnType<ProjectHandle["manifest"]>,
      updateManifest: async () => ({}) as Awaited<ReturnType<ProjectHandle["updateManifest"]>>,
    } satisfies ProjectHandle;
    const telemetry = new RunTelemetry({ version: "test" });
    const run = await telemetry.startAgentRun({
      runId: "run_incremental",
      threadId: "thread_1",
      agentId: "codex",
      projectId: project.id,
      cwd: projectDir,
      prompt: "test",
    });
    const tool = telemetry.forToolCall("run_incremental")!;
    for (let call = 0; call < 2; call++)
      await tool.traceToolCall({ name: "project_status", args: {}, project, readOnly: true }, async () => ({
        text: "ok",
      }));
    await run.finish("completed");
    await telemetry.shutdown();

    const requests = (await readFile(run.logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; body: { snapshot?: Record<string, unknown> } })
      .filter((record) => record.type === "mcp.request");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body.snapshot).toMatchObject({
      manifestPath: requests[0]!.body.snapshot!["manifestPath"],
      reused: true,
      reusedFiles: 2,
    });
    const manifest = JSON.parse(
      await readFile(requests[0]!.body.snapshot!["manifestPath"] as string, "utf8"),
    ) as { entries: Array<{ path: string; sha256: string | null; omitted?: string }> };
    expect(manifest.entries.find((entry) => entry.path === "large.bin")).toMatchObject({
      sha256: null,
      omitted: "file-over-limit",
    });
  });

  test("isolates unserializable agent events from the run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-cyclic-event-"));
    const telemetry = new RunTelemetry({ version: "test" });
    const run = await telemetry.startAgentRun({
      runId: "run_cyclic",
      threadId: "thread_1",
      agentId: "codex",
      projectId: null,
      cwd: dir,
      prompt: "test",
    });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => run.record("agent.text", cyclic)).not.toThrow();
    await run.finish("completed");
    await telemetry.shutdown();
    const records = (await readFile(run.logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; body: { omitted?: string } });
    expect(records.find((record) => record.type === "agent.text")?.body.omitted).toBe(
      "serialization-error",
    );
  });

  test("shutdown waits for an in-flight run dump finalization", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-shutdown-finalize-"));
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    const telemetry = new RunTelemetry({
      version: "test",
      runDumps: {
        async put() {
          entered();
          await blocked;
        },
      },
    });
    const run = await telemetry.startAgentRun({
      runId: "run_shutdown",
      threadId: "thread_1",
      agentId: "codex",
      projectId: null,
      cwd: dir,
      prompt: "test",
    });
    const finishing = run.finish("aborted");
    await started;
    let shutdownFinished = false;
    const shutdown = telemetry.shutdown().then(() => (shutdownFinished = true));
    await Bun.sleep(10);
    expect(shutdownFinished).toBe(false);
    release();
    await Promise.all([finishing, shutdown]);
    expect(shutdownFinished).toBe(true);
  });

  test("shutdown finalizes a still-active run before closing its dump sink", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-shutdown-active-"));
    const store = new Store(openDatabase(":memory:"));
    const telemetry = new RunTelemetry({ version: "test", runDumps: store.runDumps });
    await telemetry.startAgentRun({
      runId: "run_active_shutdown",
      threadId: "thread_1",
      agentId: "codex",
      projectId: null,
      cwd: dir,
      prompt: "test",
    });
    await telemetry.shutdown();
    const dump = JSON.parse(store.runDumps.get("run_active_shutdown")!.dumpJson) as {
      events: Array<{ type: string; body: { status?: string } }>;
    };
    expect(dump.events.at(-1)).toMatchObject({
      type: "run.finished",
      body: { status: "aborted" },
    });
    store.close();
  });
});
