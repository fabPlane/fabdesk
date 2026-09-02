/**
 * Real "say hello" runs against installed CLIs. Off by default because they spend real credits and
 * need a signed-in CLI: run with `FABDESK_AGENT_SMOKE=1 bun test smoke`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentId } from "@fabdesk/protocol";
import { adapters } from "./index";
import type { AgentEvent } from "./types";

const enabled = process.env["FABDESK_AGENT_SMOKE"] === "1";
const ids: AgentId[] = ["claude", "codex", "grok"];
const installed = enabled
  ? await Promise.all(ids.map(async (id) => [id, (await adapters[id].detect()).installed] as const))
  : [];

for (const [id, ok] of installed) {
  describe.skipIf(!ok)(`${id} smoke`, () => {
    test("says hello and finishes with exit code 0", async () => {
      const dir = mkdtempSync(join(tmpdir(), `fabdesk-smoke-${id}-`));
      try {
        const run = adapters[id].run({
          cwd: dir,
          prompt: "Say hello in one short sentence, then stop.",
          attachments: [],
          mcp: { url: "http://127.0.0.1:1/mcp", token: "smoke" },
          permission: "acceptEdits",
        });
        const events: AgentEvent[] = [];
        for await (const e of run.events) events.push(e);
        const done = events.at(-1);
        expect(done).toMatchObject({ type: "done", exitCode: 0 });
        expect(events.some((e) => e.type === "text")).toBe(true);
        expect(events.some((e) => e.type === "init")).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 180_000);
  });
}

test.skipIf(enabled)("smoke tests are disabled without FABDESK_AGENT_SMOKE=1", () => {
  expect(enabled).toBe(false);
});
