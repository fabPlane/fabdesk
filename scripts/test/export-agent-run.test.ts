import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../apps/core/src/db";
import { fetchRunDump } from "../export-agent-run";
import { fileDumpReference } from "../../apps/core/src/run-dump-file";

describe("fetchRunDump", () => {
  test("returns a complete dump from Fabdesk's SQLite database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fabdesk-run-export-"));
    const dbPath = join(dir, "fabdesk.db");
    const store = Store.open(dbPath);
    store.runDumps.put({
      runId: "run_1",
      traceId: "trace_1",
      threadId: "thread_1",
      agentId: "codex",
      projectId: "project_1",
      createdAt: "2026-09-09T00:00:00.000Z",
      dumpJson: JSON.stringify({ schema: "fabdesk.llm-run-dump/v1", runId: "run_1" }),
    });
    store.close();

    expect(JSON.parse(fetchRunDump("run_1", dbPath))).toEqual({
      schema: "fabdesk.llm-run-dump/v1",
      runId: "run_1",
    });
    expect(() => fetchRunDump("missing", dbPath)).toThrow("run dump not found: missing");
  });
  test("exports the complete file rather than its SQLite reference",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"fabdesk-file-export-"));
    const path=join(dir,"llm-dump.json"),content=JSON.stringify({schema:"fabdesk.llm-run-dump/v1",events:["x".repeat(2*1024*1024)]});
    await writeFile(path,content);
    const db=join(dir,"fabdesk.db"),store=Store.open(db);
    store.runDumps.put({runId:"large",traceId:"trace",threadId:"thread",agentId:"codex",projectId:null,createdAt:new Date().toISOString(),dumpJson:await fileDumpReference(path)});
    store.close();
    expect(fetchRunDump("large",db)).toBe(content);
  });

});
