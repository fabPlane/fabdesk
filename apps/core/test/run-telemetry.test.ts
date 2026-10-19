import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, truncate, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectHandle } from "@fabdesk/tools";
import { Store, openDatabase } from "../src/db";
import { RunTelemetry } from "../src/run-telemetry";
import { parseDumpFile } from "../src/run-dump-file";
import { createHash } from "node:crypto";

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
      "snapshot.final",
      "run.finished",
    ]);
    expect(records.map((record) => record.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
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

  test("reuses unchanged snapshots and preserves large binary files exactly", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "fabdesk-incremental-snapshot-"));
    await writeFile(join(projectDir, "board.kicad_pcb"), "board");
    const oversized = join(projectDir, "large.bin");
    await writeFile(oversized, "");
    await truncate(oversized, 6 * 1024 * 1024 + 1);
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
    const entry = manifest.entries.find((entry) => entry.path === "large.bin")!;
    expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
    const dump = JSON.parse(await readFile(join(projectDir, ".fabdesk/runs/run_incremental/llm-dump.json"), "utf8"));
    const bytes = Buffer.from(dump.blobs[entry.sha256!].content, "base64");
    expect(bytes.length).toBe(6 * 1024 * 1024 + 1);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256!);
  });

  test("keeps >2 MiB events, >12 MiB history, >32 MiB dumps and a final event", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-full-trace-"));
    const store = new Store(openDatabase(":memory:"));
    const telemetry = new RunTelemetry({ version: "test", runDumps: store.runDumps });
    try {
      const run = await telemetry.startAgentRun({ runId: "large", threadId: "thread", agentId: "codex", projectId: null, cwd: dir, prompt: "large full capture" });
      const output = "begin-" + "a".repeat(3 * 1024 * 1024) + "-end";
      for (let i = 0; i < 14; i++) run.record("agent.tool_result", { id: String(i), output });
      await run.finish("completed");
      const reference = parseDumpFile(store.runDumps.get("large")!.dumpJson)!;
      expect(reference.bytes).toBeGreaterThan(40 * 1024 * 1024);
      const bytes = await readFile(reference.path);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(reference.sha256);
      const dump = JSON.parse(bytes.toString());
      expect(dump.events).toHaveLength(16);
      for (const event of dump.events.slice(1, -1)) expect(event.body.output).toBe(output);
      expect(dump.events.at(-1).type).toBe("run.finished");
      expect(dump.events.some((e: {type:string}) => e.type === "telemetry.truncated")).toBe(false);
    } finally { await telemetry.shutdown(); store.close(); await rm(dir, {recursive:true,force:true}); }
  });

  test("preserves more than 128 snapshots and 2000 files, including final native edits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-full-snapshots-"));
    const project = { id:"full", name:"full", dir, manifest:()=>({}) as ReturnType<ProjectHandle["manifest"]>, updateManifest:async()=>({}) as Awaited<ReturnType<ProjectHandle["updateManifest"]>> } satisfies ProjectHandle;
    const telemetry = new RunTelemetry({version:"test"});
    try {
      await Promise.all(Array.from({length:2001},(_,i)=>writeFile(join(dir,`f${i}.txt`), String(i))));
      const run = await telemetry.startAgentRun({runId:"snapshots",threadId:"thread",agentId:"codex",projectId:project.id,cwd:dir,prompt:"snapshot boundaries"});
      const tools = telemetry.forToolCall("snapshots")!;
      for(let i=0;i<130;i++) await tools.traceToolCall({name:"edit",args:{},project,readOnly:false}, async()=>{await writeFile(join(dir,"board.txt"),String(i));return {text:"ok"};});
      await writeFile(join(dir,"final-native.txt"),"last file");
      await run.finish("completed");
      const dump = JSON.parse(await readFile(join(dir,".fabdesk/runs/snapshots/llm-dump.json"),"utf8"));
      expect(dump.snapshots.length).toBe(131);
      expect(dump.snapshots[0].entries.length).toBe(2001);
      expect(dump.snapshots.at(-1).entries.some((e:{path:string})=>e.path==="final-native.txt")).toBe(true);
      expect(dump.snapshots.every((s:{omissions:unknown[]})=>s.omissions.length===0)).toBe(true);
    } finally {await telemetry.shutdown();await rm(dir,{recursive:true,force:true});}
  }, 30000);

  test("pending large run survives project removal in stable profile storage",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"fabdesk-stable-dump-")),projectDir=join(dir,"project");
    await mkdir(projectDir);
    const store=Store.open(join(dir,"fabdesk.db"));
    const telemetry=new RunTelemetry({version:"test",runDumps:store.runDumps,dumpDirectory:join(dir,"run-dumps")});
    try {
      const run=await telemetry.startAgentRun({runId:"stable",threadId:"thread",agentId:"codex",projectId:null,cwd:projectDir,prompt:"test"});
      run.record("agent.tool_result",{output:"x".repeat(2*1024*1024)});
      await run.finish("completed");
      const ref=parseDumpFile(store.runDumps.get("stable")!.dumpJson)!;
      await rm(projectDir,{recursive:true,force:true});
      const bytes=await readFile(ref.path);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(ref.sha256);
      expect(JSON.parse(bytes.toString()).events.at(-1).type).toBe("run.finished");
    } finally {await telemetry.shutdown();store.close();await rm(dir,{recursive:true,force:true});}
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
