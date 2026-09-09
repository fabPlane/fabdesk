import { describe, expect, test } from "bun:test";
import type { FpPcbCompileJob } from "@fabdesk/protocol";
import { createFpPcbDesign } from "../src/fp-pcb-design";
import type { FpPcbBridgeClient } from "../src/fp-pcb-bridge";
import type { FpPcbSessions, ProjectSession } from "../src/fp-pcb-session";

describe("FabPCB build recovery", () => {
  test("releases a bare session when NewProject leaves a board behind", async () => {
    const released: string[] = [];
    const job = {
      id: "compile-1",
      sessionId: "session-1",
      frontend: "netlist-json",
      state: "failed",
      startedAt: new Date().toISOString(),
      log: [],
      error: "NewProject: AS_BAD_REQUEST - request failed: Failed to load kiface library",
    } as FpPcbCompileJob;
    const bridge = {
      compile: async () => job,
    } as unknown as FpPcbBridgeClient;
    const session = { id: "session-1", path: null } as ProjectSession;
    const sessions = {
      withRetry: async (_projectDir: string, run: (value: ProjectSession) => Promise<FpPcbCompileJob>) => run(session),
      release: async (projectDir: string) => {
        released.push(projectDir);
      },
    } as unknown as FpPcbSessions;
    const design = createFpPcbDesign({
      bridge: () => bridge,
      sessions,
      readText: async () => "{}",
      exists: async (path) => path.endsWith("circuit.netlist.json") || path.endsWith("board.kicad_pcb"),
    });

    const result = await design.build({ projectDir: "/workspace/partial" });
    expect(result.ok).toBe(false);
    expect(released).toEqual(["/workspace/partial"]);
  });
});
