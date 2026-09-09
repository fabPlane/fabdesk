import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectHandle } from "@fabdesk/tools";
import { RunTelemetry } from "../src/run-telemetry";

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

    const telemetry = new RunTelemetry({ version: "test" });
    const agent = await telemetry.startAgentRun({
      runId: "run_1",
      threadId: "thread_1",
      agentId: "codex",
      projectId: project.id,
      cwd: projectDir,
      prompt: "inspect the board",
    });
    await agent.record("agent.text", { delta: "checking" });
    const tool = telemetry.forToolCall("run_1")!;
    const output = await tool.traceToolCall(
      { name: "verify_drc", args: { project: project.id }, project, sessionId: "mcp_1" },
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
    expect(
      records.every(
        (record, index) =>
          index === 0 || BigInt(record.timeUnixNano) >= BigInt(records[index - 1]!.timeUnixNano),
      ),
    ).toBe(true);

    const request = records.find((record) => record.type === "mcp.request")!;
    const snapshot = request.body["snapshot"] as { manifestPath: string };
    const manifest = JSON.parse(await readFile(snapshot.manifestPath, "utf8")) as {
      entries: Array<{ path: string; blob: string }>;
    };
    const source = manifest.entries.find((entry) => entry.path === "circuit.netlist.json")!;
    expect(
      await readFile(
        join(projectDir, ".fabdesk", "runs", "run_1", "snapshots", source.blob),
        "utf8",
      ),
    ).toBe('{"before":true}\n');
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
});
