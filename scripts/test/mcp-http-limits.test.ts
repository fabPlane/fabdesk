import { expect, test } from "bun:test";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

function request(body: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body,
  });
}

// GHSA-f897-62hf-6gxq affects the separately packaged MCP 2.x server too.
// Test actual transport responses, not a lockfile-version comparison.
test("MCP 2.x rejects oversized declared and streamed HTTP bodies before parsing", async () => {
  const body = " ".repeat(4 * 1024 * 1024 + 1);
  for (const headers of [{}, { "content-length": String(body.length) }]) {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    try {
      const response = await transport.handleRequest(request(body, headers));
      expect(response.status).toBe(413);
      await response.text();
    } finally {
      await transport.close();
    }
  }
});

test("MCP 2.x bounds JSON-RPC batches before dispatch and accepts an ordinary request", async () => {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const next = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  let dispatched = 0;
  transport.onmessage = () => {
    dispatched++;
  };
  next.onmessage = transport.onmessage;
  try {
    const notification = { jsonrpc: "2.0", method: "notifications/initialized" };
    const response = await transport.handleRequest(
      request(JSON.stringify(Array(101).fill(notification))),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("100");
    expect(dispatched).toBe(0);
    const ordinary = await next.handleRequest(request(JSON.stringify(notification)));
    expect(ordinary.status).toBe(202);
    await ordinary.text();
    expect(dispatched).toBe(1);
  } finally {
    await transport.close();
    await next.close();
  }
});
