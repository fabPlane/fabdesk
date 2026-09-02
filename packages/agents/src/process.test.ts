import { describe, expect, test } from "bun:test";
import { MessagesStreamParser } from "./parsers/messages";
import { descendantPids, runAgentProcess } from "./process";
import type { AgentEvent } from "./types";

const bun = process.execPath;

async function collect(run: { events: AsyncIterable<AgentEvent> }): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of run.events) out.push(e);
  return out;
}

function script(lines: string[]): string {
  return lines.join("\n");
}

describe("runAgentProcess", () => {
  test("streams parsed events then done with the exit code and session id", async () => {
    const parser = new MessagesStreamParser();
    const run = runAgentProcess({
      cmd: [
        bun,
        "-e",
        script([
          'console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "m" }));',
          'console.log("not json");',
          'console.log(JSON.stringify({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "hi" }] } }));',
        ]),
      ],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      parse: (l) => parser.feed(l),
      sessionId: () => parser.sessionId,
    });
    expect(typeof run.pid).toBe("number");
    const events = await collect(run);
    expect(events).toEqual([
      { type: "init", sessionId: "s1", model: "m" },
      { type: "text", delta: "hi" },
      { type: "done", exitCode: 0, sessionId: "s1" },
    ]);
  });

  test("non-zero exit without an error event surfaces stderr", async () => {
    let cleaned = false;
    const run = runAgentProcess({
      cmd: [bun, "-e", 'console.error("auth required: run login"); process.exit(2);'],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      parse: () => [],
      cleanup: () => {
        cleaned = true;
      },
    });
    const events = await collect(run);
    expect(events).toEqual([
      { type: "error", message: "auth required: run login" },
      { type: "done", exitCode: 2 },
    ]);
    expect(cleaned).toBe(true);
  });

  test("a missing binary yields error + done(-1) instead of throwing", async () => {
    const run = runAgentProcess({
      cmd: ["/definitely/not/here/agent-binary", "-p"],
      cwd: process.cwd(),
      env: {},
      parse: () => [],
    });
    expect(run.pid).toBeUndefined();
    const events = await collect(run);
    expect(events[0]?.type).toBe("error");
    expect(events[1]).toEqual({ type: "done", exitCode: -1 });
  });

  test("abort() interrupts a long-running process tree", async () => {
    const run = runAgentProcess({
      cmd: [
        bun,
        "-e",
        script([
          'console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s2" }));',
          'const child = Bun.spawn(["sleep", "60"]);',
          "await Bun.sleep(60_000);",
        ]),
      ],
      cwd: process.cwd(),
      env: { ...process.env } as Record<string, string>,
      parse: (l) => new MessagesStreamParser().feed(l),
    });
    const events: AgentEvent[] = [];
    const started = Date.now();
    for await (const e of run.events) {
      events.push(e);
      if (e.type === "init") {
        // give the child a moment to spawn, then confirm the tree is visible and abort it
        await Bun.sleep(300);
        expect(descendantPids(run.pid as number).length).toBeGreaterThanOrEqual(1);
        run.abort();
      }
    }
    expect(Date.now() - started).toBeLessThan(5000);
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    expect(events.some((e) => e.type === "error")).toBe(false);
    await Bun.sleep(200);
    expect(descendantPids(run.pid as number)).toEqual([]);
  }, 15_000);
});
