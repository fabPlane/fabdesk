import { afterEach, expect, test } from "bun:test";
import { ToolRegistry } from "@fabdesk/tools";
import { PERMISSION_PROMPT_TOOL } from "@fabdesk/agents";
import { McpSessionManager } from "../src/mcp-sessions";
import { MCP_MAX_REQUEST_BYTES, MCP_MAX_TOOL_INPUT_ELEMENTS } from "../src/mcp-limits";

const managers: McpSessionManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.closeAll()));
});

async function session() {
  const handled: unknown[] = [];
  const manager = new McpSessionManager({
    version: "test",
    registry: new ToolRegistry(),
    ctxFactory: async () => {
      throw new Error("No registry tool should execute");
    },
    permissionPrompt: {
      enabledFor: () => true,
      handle: async (_token, request) => {
        handled.push(request.input);
        return { behavior: "deny", message: "Test only" };
      },
    },
  });
  managers.push(manager);
  let sessionId: string | null = null;
  let id = 0;
  const send = async (body: string, extraHeaders: Record<string, string> = {}) => {
    const response = await manager.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          ...extraHeaders,
        },
        body,
      }),
    );
    sessionId ??= response.headers.get("mcp-session-id");
    return response;
  };
  const call = (input: unknown) =>
    send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: { name: PERMISSION_PROMPT_TOOL, arguments: { tool_name: "test", input } },
      }),
    );
  const initialized = await send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: ++id,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "limits-test", version: "0" },
      },
    }),
  );
  expect(initialized.status).toBe(200);
  await initialized.text();
  expect(sessionId).not.toBeNull();
  return { call, send, handled };
}

test("rejects nested oversized tool input before its handler and keeps the session usable", async () => {
  const { call, handled } = await session();
  // Many short invalid values fit comfortably within the HTTP byte limit.
  const input = { nested: [Array.from({ length: MCP_MAX_TOOL_INPUT_ELEMENTS }, () => 0)] };
  const response = await call(input);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain('"isError":true');
  expect(text).toContain(`maximum of ${MCP_MAX_TOOL_INPUT_ELEMENTS} elements`);
  expect(handled).toHaveLength(0);

  const components = Array.from({ length: 1_000 }, (_, i) => ({
    ref: `R${i}`,
    value: "1k",
    x: i,
    y: 0,
  }));
  expect(await (await call({ components })).text()).not.toContain('"isError":true');
  expect(handled).toEqual([{ components }]);
});

test("counts object members as well as array elements", async () => {
  const { call, handled } = await session();
  const members = Object.fromEntries(
    Array.from({ length: MCP_MAX_TOOL_INPUT_ELEMENTS }, (_, i) => [`k${i}`, 0]),
  );
  expect(await (await call(members)).text()).toContain(
    `maximum of ${MCP_MAX_TOOL_INPUT_ELEMENTS} elements`,
  );
  expect(handled).toHaveLength(0);
});

test("rejects over-limit HTTP bodies with and without a declared length", async () => {
  const { send, call, handled } = await session();
  const body = " ".repeat(MCP_MAX_REQUEST_BYTES + 1);
  for (const headers of [{}, { "content-length": String(body.length) }]) {
    const response = await send(body, headers);
    expect(response.status).toBe(413);
    await response.text();
  }
  expect(handled).toHaveLength(0);
  await (await call({ ok: true })).text();
  expect(handled).toEqual([{ ok: true }]);
});
