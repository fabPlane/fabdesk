import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../apps/core/src/db";
import { fetchRunDump } from "../export-agent-run";

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
});
