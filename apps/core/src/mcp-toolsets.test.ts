import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  applyStartToolsets,
  BOARD_START_TOOLS,
  BOARD_WORKFLOW_PROMPT,
  BOARD_WORKFLOW_RESOURCE_URI,
  boardStartTools,
  boardWorkflowInstructions,
  boardWorkflowPromptText,
  boardWorkflowStages,
  DURABLE_WAIT_SHORT_MS,
  durableWaitForClient,
  initialToolsetsFor,
  nativeToolsFor,
  NATIVE_AGENT_TOOLS,
  projectStartToolsets,
  registerBoardWorkflowDocs,
  startOptionsFor,
} from "./mcp-sessions";
import { BOARD_START_MAP_MD, BOARD_WORKFLOW_MD } from "@fabdesk/agents";
import { createRegistry } from "@fabdesk/tools";
import { stepsFor } from "../../../packages/board-workflow/src/lastmile/actions";

describe("initialToolsetsFor", () => {
  test("defaults, the full set, and a comma list added to the defaults", () => {
    expect(initialToolsetsFor(null)).toEqual(["circuit", "verify", "render"]);
    expect(initialToolsetsFor("all")).toContain("board");
    expect(initialToolsetsFor("board")).toEqual(["circuit", "verify", "render", "board"]);
    expect(initialToolsetsFor("board,bogus,shopping")).toEqual(["circuit", "verify", "render", "shopping", "board"]);
  });
});

describe("nativeToolsFor", () => {
  const registry = { byToolset: (id: string) => (id === "board" ? [{ name: "board_job" }, { name: "board_check" }] : []) } as never;
  test("the fixed native list gains a requested toolset's tools, nothing otherwise", () => {
    expect(nativeToolsFor(null, registry)).toEqual([...NATIVE_AGENT_TOOLS]);
    expect(nativeToolsFor("board", registry)).toEqual([...NATIVE_AGENT_TOOLS, "board_job", "board_check"]);
    expect(nativeToolsFor("bogus", registry)).toEqual([...NATIVE_AGENT_TOOLS]);
  });
});

describe("boardStartTools", () => {
  const registry = { byToolset: (id: string) => ({ core: [{ name: "load_toolset" }], verify: [{ name: "verify_drc" }], render: [{ name: "render_view" }], board: [{ name: "board_job" }] } as Record<string, Array<{ name: string }>>)[id] ?? [] } as never;
  test("board-reading tools plus core, verify, render and board; no authoring tools", () => {
    const names = boardStartTools(registry);
    for (const n of [...BOARD_START_TOOLS, "load_toolset", "render_view", "board_job"]) expect(names).toContain(n);
    // board_check supersedes verify_drc: one way to do the job in the start set
    expect(names).not.toContain("verify_drc");
    for (const n of ["schematic_edit", "native_edit_transaction", "pcb_edit_graphics", "circuit_build"]) expect(names).not.toContain(n);
  });
  test("with the real registry: board tools replace verify_drc; uncovered tools stay", () => {
    const names = boardStartTools(createRegistry());
    for (const n of ["board_check", "board_route", "board_edit", "board_review", "board_release", "pcb_inspect", "schematic_inspect", "render_view", "route_run", "verify_erc"]) expect(names).toContain(n);
    for (const n of ["verify_drc", "verify_gate", "release_build"]) expect(names).not.toContain(n);
  });
  test("the placeholder list names only tools that exist", () => {
    const reg = createRegistry();
    for (const n of BOARD_START_TOOLS) expect(reg.get(n)).toBeDefined();
  });
});

describe("external sessions: the desktop's start-set decision", () => {
  const withBoard = { get: (n: string) => (n === "board_check" ? ({} as never) : undefined) };
  const withoutBoardWorkflow = { get: () => undefined };
  const dirWith = async (pcb: string | null) => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "start-set-"));
    if (pcb !== null) await writeFile(join(dir, "board.kicad_pcb"), pcb);
    return { dir };
  };
  test("a placed board starts with `board`; no board, an empty board, no project or no board_check do not", async () => {
    const placed = await dirWith('(kicad_pcb\n  (footprint "R:0603"\n))');
    expect(await projectStartToolsets(withBoard, placed)).toEqual(["board"]);
    expect(await projectStartToolsets(withoutBoardWorkflow, placed)).toEqual([]);
    expect(await projectStartToolsets(withBoard, await dirWith("(kicad_pcb (version 1))"))).toEqual([]);
    expect(await projectStartToolsets(withBoard, await dirWith(null))).toEqual([]);
    expect(await projectStartToolsets(withBoard, null)).toEqual([]);
  });
  test("the query and start options equal a desktop run's endpoint on that project", () => {
    const registry = createRegistry();
    const q = new URLSearchParams();
    applyStartToolsets(q, ["board"]);
    expect(q.get("toolsets")).toBe("board");
    expect(q.get("start")).toBe("board");
    const opts = startOptionsFor(q, registry);
    expect(opts.initialToolsets).toEqual(initialToolsetsFor("board"));
    expect(opts.initialTools).toEqual(boardStartTools(registry));
    const none = new URLSearchParams();
    applyStartToolsets(none, []);
    expect([...none.keys()]).toEqual([]);
    expect(startOptionsFor(none, registry)).toEqual({ initialToolsets: initialToolsetsFor(null) });
  });
});

describe("durableWaitForClient", () => {
  test("fabdesk's own runs and Claude Code keep the default; external Codex and unknown clients return a job id in 50 s", () => {
    expect(durableWaitForClient({ name: "codex-mcp-client" }, { ownRun: true })).toBeUndefined();
    expect(durableWaitForClient({ name: "claude-code", version: "2.1.0" })).toBeUndefined();
    expect(durableWaitForClient({ name: "codex-mcp-client" })).toBe(DURABLE_WAIT_SHORT_MS);
    expect(durableWaitForClient({ name: "some-host" })).toBe(DURABLE_WAIT_SHORT_MS);
    expect(durableWaitForClient(undefined)).toBe(DURABLE_WAIT_SHORT_MS);
    expect(DURABLE_WAIT_SHORT_MS).toBeLessThan(60_000);
  });
  test("a declared tool timeout waits just under it, capped at 25 min, and wins over the client name", () => {
    expect(durableWaitForClient({ name: "codex-mcp-client", toolTimeoutSec: 1830 })).toBe(25 * 60_000);
    expect(durableWaitForClient({ name: "codex-mcp-client" }, { toolTimeoutSec: 120 })).toBe(110_000);
    expect(durableWaitForClient({ name: "claude-code", toolTimeoutSec: 60 })).toBe(50_000);
    expect(durableWaitForClient({ toolTimeoutSec: 8 })).toBe(6_000);
  });
});

test("start map tools and documented arguments exist in the current registry", () => {
  const registry = createRegistry();
  // MCP capability tools are registered by the adapter, rather than the registry.
  const names = [...BOARD_START_MAP_MD.matchAll(/`([a-z]+_[a-z_]+)(?:`| )/g)]
    .map((match) => match[1]!)
    .filter((name) => !["capability_search", "capability_call"].includes(name));
  for (const name of names) expect(registry.get(name)).toBeDefined();
  const samples: Array<[string, Record<string, unknown>]> = [
    ["circuit_source", { action: "schema" }],
    ["circuit_source", { action: "validate" }],
    ["schematic_inspect", { detail: "authoring" }],
    ["pcb_update_from_schematic", { apply: true }],
    ["circuit_search_parts", { query: "part", kind: "symbol" }],
    ["circuit_describe_part", { kind: "symbol", libId: "Library:Part" }],
    ["board_check", { confirm: true }],
    ["board_edit", { plan: "edit-plan.json", mode: "impact" }],
    ["board_edit", { plan: "edit-plan.json", mode: "full", adopt: true }],
    ...["check", "place", "rank", "route", "new", "why", "validate", "accept"].map(
      (action): [string, Record<string, unknown>] => ["board_route", { action }],
    ),
    ["board_route", { action: "try", actions: ["finish"] }],
    ["board_route", { action: "try", actions: ["opens"] }],
    ["board_review", { action: "run" }],
    ["board_review", { action: "autopilot" }],
  ];
  for (const [name, args] of samples) {
    expect(registry.inputObject(registry.get(name)!).safeParse(args).success).toBe(true);
  }
  // The tool schema accepts arbitrary strings here; validate the documented values
  // with the same action parser used by the last-mile runner.
  const lastMile = BOARD_START_MAP_MD.split("\n").find((line) => line.startsWith("| Last mile |"))!;
  const actions = [...lastMile.matchAll(/\["([a-z]+)"\]/g)].map((match) => match[1]!);
  expect(actions).toEqual(["finish", "opens"]);
  for (const action of actions) expect(stepsFor(action).length).toBeGreaterThan(0);
});

describe("board workflow instructions, resource and prompt come from BOARD_WORKFLOW_MD", () => {
  test("the registered resource and prompt retain the complete workflow", async () => {
    const server = new McpServer({ name: "workflow-test", version: "0.0.0" });
    registerBoardWorkflowDocs(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const resource = await client.readResource({ uri: BOARD_WORKFLOW_RESOURCE_URI });
      const content = resource.contents[0];
      expect(content && "text" in content ? content.text : undefined).toBe(BOARD_WORKFLOW_MD);
      const prompt = await client.getPrompt({ name: BOARD_WORKFLOW_PROMPT });
      expect(prompt.messages[0]?.content).toEqual({
        type: "text", text: boardWorkflowPromptText(),
      });
      expect(boardWorkflowPromptText().endsWith(BOARD_WORKFLOW_MD)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("the stage table is read from the workflow text", () => {
    const stages = boardWorkflowStages();
    expect(stages.length).toBeGreaterThanOrEqual(6);
    for (const r of stages) expect(BOARD_WORKFLOW_MD).toContain(`| ${r.stage} | \`${r.tool}\``);
    for (const tool of ["board_check", "board_route", "board_edit", "board_review", "board_silk", "board_release"])
      expect(stages.map((r) => r.tool)).toContain(tool);
  });
  test("the instructions name every stage tool, A1-A9, board_job and where the full text is", () => {
    const text = boardWorkflowInstructions();
    for (const r of boardWorkflowStages()) expect(text).toContain(`${r.stage} \`${r.tool}\``);
    for (const s of ["A1-A9", "board_job", "install on demand", BOARD_WORKFLOW_RESOURCE_URI, BOARD_WORKFLOW_PROMPT, "load_toolset"]) expect(text).toContain(s);
    expect(boardWorkflowInstructions({ listed: true })).toContain("listed from the start");
    expect(text.length).toBeLessThan(1500);
  });
  test("the prompt carries the full workflow text", () => {
    const text = boardWorkflowPromptText("Blinky", "release it");
    expect(text).toContain('project="Blinky"');
    expect(text).toContain("Request: release it");
    expect(text.endsWith(BOARD_WORKFLOW_MD)).toBe(true);
  });
});

test("the plugin skill's board section names every stage tool, board_job and the workflow resource and prompt", async () => {
  const { readFileSync } = await import("node:fs");
  const skill = readFileSync(new URL("../../../plugins/fabplane/skills/fabplane/SKILL.md", import.meta.url), "utf8");
  for (const r of boardWorkflowStages()) expect(skill).toContain(`| ${r.stage} | \`${r.tool}\``);
  for (const s of ["board_job", "A1-A9", BOARD_WORKFLOW_RESOURCE_URI, BOARD_WORKFLOW_PROMPT]) expect(skill).toContain(s);
});
