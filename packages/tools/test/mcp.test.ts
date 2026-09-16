import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { attachToRegistry, createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

async function pair(initialTools?: string[], capabilityExclude?: string[]) {
  const registry = createRegistry();
  const project = await tempProject("mcp");
  const services = mockServices([project]);
  const server = new McpServer({ name: "fabdesk-test", version: "0.0.0" });
  const attachment = attachToRegistry(server, registry, contextFactory(services, project), {
    ...(initialTools ? { initialTools } : {}),
    ...(capabilityExclude ? { capabilityExclude } : {}),
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientT);
  return { client, server, attachment, project, services, registry };
}

describe("mcp adapter", () => {
  test("native profile is small and searches/calls the hidden catalog", async () => {
    const { client } = await pair(["project_status", "pcb_inspect"]);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "capability_call",
      "capability_search",
      "pcb_inspect",
      "project_status",
    ]);
    const undiscovered = await client.callTool({
      name: "capability_call",
      arguments: {
        name: "circuit_describe_part",
        arguments: { kind: "symbol", libId: "Device:R" },
      },
    });
    expect(undiscovered.isError).toBe(true);
    const search = await client.callTool({
      name: "capability_search",
      arguments: { query: "describe part pins" },
    });
    const matches = (search.structuredContent as { matches: Array<{ name: string }> }).matches;
    expect(matches.some((match) => match.name === "circuit_describe_part")).toBe(true);
    const called = await client.callTool({
      name: "capability_call",
      arguments: {
        name: "circuit_describe_part",
        arguments: { kind: "symbol", libId: "Device:R" },
      },
    });
    expect(called.isError).toBeFalsy();
    expect((called.content as Array<{ text?: string }>)[0]?.text).toContain("symbol Device:R");
  });

  test("native capability search hides legacy netlist compiler operations", async () => {
    const { client } = await pair(
      ["project_status", "pcb_inspect"],
      ["circuit_build", "circuit_read_errors", "load_toolset"],
    );
    const search = await client.callTool({
      name: "capability_search",
      arguments: { query: "netlist libSource build errors", limit: 20 },
    });
    const names = (search.structuredContent as { matches: Array<{ name: string }> }).matches.map(
      (match) => match.name,
    );
    expect(names).not.toContain("circuit_build");
    expect(names).not.toContain("circuit_read_errors");
    expect(names).not.toContain("load_toolset");
  });

  test("core tools visible, load_toolset enables more and emits list_changed", async () => {
    const { client, attachment } = await pair();
    const initial = await client.listTools();
    const names = initial.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "capability_call",
      "capability_search",
      "circuit_build",
      "circuit_place",
      "circuit_read_errors",
      "load_toolset",
      "pcb_environment",
      "project_status",
      "render_board",
      "route_run",
      "verify_drc",
    ]);
    const t = initial.tools.find((x) => x.name === "circuit_build")!;
    expect(
      (t.inputSchema as { properties: Record<string, unknown> }).properties["project"],
    ).toBeDefined();
    expect(t.annotations?.idempotentHint).toBe(true);

    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      listChanged++;
    });
    const res = await client.callTool({ name: "load_toolset", arguments: { toolset: "export" } });
    expect(res.isError).toBeFalsy();
    const after = await client.listTools();
    expect(after.tools.map((t) => t.name)).toContain("export_gerbers");
    expect(after.tools.length).toBe(11 + 7);
    expect(attachment.session.enabledToolsets()).toEqual(["core", "export"]);
    await new Promise((r) => setTimeout(r, 10));
    expect(listChanged).toBeGreaterThan(0);
  });

  test("project_status, build with progress, structured content and errors", async () => {
    const { client } = await pair();
    const status = await client.callTool({ name: "project_status", arguments: {} });
    const text = (status.content as Array<{ type: string; text?: string }>)[0]!.text!;
    expect(text).toContain('Project "mcp"');
    expect((status.structuredContent as { name: string }).name).toBe("mcp");

    const progress: number[] = [];
    const build = await client.callTool({ name: "circuit_build", arguments: {} }, undefined, {
      onprogress: (p) => progress.push(p.progress),
    });
    expect(build.isError).toBeFalsy();
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(100);

    // A long-running tool repeats its last progress on a timer so a client with an idle timeout
    // (Claude Code aborts after ~5 silent minutes) keeps waiting through a quiet solver phase.
    process.env["FABDESK_MCP_HEARTBEAT_MS"] = "2";
    try {
      const beats: number[] = [];
      await client.callTool({ name: "route_run", arguments: { timeoutMs: 1000 } }, undefined, {
        onprogress: (p) => beats.push(p.progress),
      });
      const repeats = beats.filter((v, i) => i > 0 && v === beats[i - 1]).length;
      expect(repeats).toBeGreaterThan(0);
    } finally {
      delete process.env["FABDESK_MCP_HEARTBEAT_MS"];
    }

    const bad = await client.callTool({
      name: "circuit_read_errors",
      arguments: { project: "does-not-exist" },
    });
    expect(bad.isError).toBe(true);
    expect((bad.content as Array<{ text: string }>)[0]!.text).toContain("no project selected");
  });

  test("svg render returns an embedded resource; resources are listed without workflow prompts", async () => {
    const { client, project } = await pair();
    await client.callTool({ name: "circuit_build", arguments: {} });
    await client.callTool({ name: "load_toolset", arguments: { toolset: "render" } });
    const svg = await client.callTool({ name: "render_pcb_svg", arguments: {} });
    const blocks = svg.content as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(["text", "resource"]);

    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual([
      "fabdesk://project/{id}/board-summary",
      "fabdesk://project/{id}/manifest",
      "fabdesk://project/{id}/reports/{name}",
    ]);
    const list = await client.listResources();
    expect(list.resources.some((r) => r.uri === `fabdesk://project/${project.id}/manifest`)).toBe(
      true,
    );
    const manifest = await client.readResource({ uri: `fabdesk://project/${project.id}/manifest` });
    expect(JSON.parse(manifest.contents[0]!.text as string).name).toBe("mcp");
    const summary = await client.readResource({
      uri: `fabdesk://project/${project.id}/board-summary`,
    });
    expect(JSON.parse(summary.contents[0]!.text as string).built).toBe(true);
    const report = await client.readResource({
      uri: `fabdesk://project/${project.id}/reports/build`,
    });
    expect(JSON.parse(report.contents[0]!.text as string).ok).toBe(true);

    expect(client.getServerCapabilities()?.prompts).toBeUndefined();
  });
});
