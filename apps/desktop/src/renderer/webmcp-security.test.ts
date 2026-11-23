import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// Exercise the installed global bridge, including our Bun patch. No Electron or
// native browser API is needed: the boundary under test is its MCP message wire.
test("browser MCP rejects excessive validation work and still executes ordinary tools", async () => {
  const globals = ["window", "document", "navigator", "location", "isSecureContext"] as const;
  const previous = globals.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const native = Object.assign(new EventTarget(), {
    registerTool: async () => {},
    unregisterTool: () => {},
    getTools: async () => [],
  });
  const doc = Object.assign(new EventTarget(), { modelContext: native });
  const nav = {};
  const location = new URL("https://fabdesk.test/");
  const win = Object.assign(new EventTarget(), {
    document: doc,
    navigator: nav,
    location,
    postMessage(data: unknown) {
      queueMicrotask(() => {
        const event = new Event("message");
        Object.assign(event, { data, origin: location.origin, source: win });
        win.dispatchEvent(event);
      });
    },
  });
  Object.assign(win, { parent: win });
  Object.assign(doc, { defaultView: win });
  for (const [key, value] of Object.entries({
    window: win,
    document: doc,
    navigator: nav,
    location,
    isSecureContext: true,
  }))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  let cleanup: (() => void) | undefined;
  const client = new Client({ name: "webmcp-limit-test", version: "0" });
  const receive = (event: Event) => {
    const { data } = event as unknown as { data: { direction?: string; payload?: unknown } };
    if (data.direction === "server-to-client" && typeof data.payload === "object")
      transport.onmessage?.(data.payload as Parameters<NonNullable<Transport["onmessage"]>>[0]);
  };
  const transport: Transport = {
    start: async () => {
      win.addEventListener("message", receive);
    },
    send: async (payload) => {
      win.postMessage({
        channel: "mcp-default",
        type: "mcp",
        direction: "client-to-server",
        payload,
      });
    },
    close: async () => {
      win.removeEventListener("message", receive);
    },
  };
  try {
    const bridge = await import("@mcp-b/global");
    cleanup = bridge.cleanupWebModelContext;
    bridge.initializeWebModelContext();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const context = doc.modelContext as unknown as {
      registerTool(tool: {
        name: string;
        description: string;
        inputSchema: object;
        execute: (args: { values: string[] }) => unknown;
      }): Promise<unknown>;
    };
    let calls = 0;
    await context.registerTool({
      name: "limit_probe",
      description: "Security regression fixture",
      inputSchema: {
        type: "object",
        properties: { values: { type: "array", items: { type: "string" } } },
        required: ["values"],
      },
      execute: (args) => {
        calls++;
        return { content: [{ type: "text", text: args.values.join(",") }] };
      },
    });
    await client.connect(transport);
    expect((await client.listTools()).tools.some((tool) => tool.name === "limit_probe")).toBe(true);
    const rejected = await client.callTool({
      name: "limit_probe",
      arguments: { values: Array(50_001).fill(0) },
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).toContain("maximum of 50000 elements");
    expect(calls).toBe(0);
    const accepted = await client.callTool({
      name: "limit_probe",
      arguments: { values: ["working"] },
    });
    expect(accepted.isError).toBeFalsy();
    expect(JSON.stringify(accepted)).toContain("working");
    expect(calls).toBe(1);
  } finally {
    await client.close();
    cleanup?.();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
