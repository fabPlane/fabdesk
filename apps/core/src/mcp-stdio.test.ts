import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod/v4";
import { MCP_CLIENT_META } from "@fabdesk/tools";
import { forwardRequests, proxyRequestTimeoutMs } from "./mcp-stdio";
import { DURABLE_WAIT_MAX_MS } from "./mcp-sessions";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** host Client -> downstream Server (the stdio proxy) -> upstream Client -> upstream McpServer (the daemon). */
async function chain(timeoutMs: number) {
  const seen: { meta?: Record<string, unknown>; args?: Record<string, unknown>; aborted?: boolean } = {};
  const daemon = new McpServer({ name: "daemon", version: "0" });
  daemon.registerTool(
    "slow",
    { inputSchema: { ms: z.number(), project: z.string().optional() } as unknown as ZodRawShapeCompat },
    async (args: Record<string, unknown>, extra) => {
      seen.meta = extra._meta as Record<string, unknown>;
      seen.args = args;
      const token = extra._meta?.progressToken;
      const until = Date.now() + Number(args["ms"]);
      let n = 0;
      while (Date.now() < until) {
        if (extra.signal.aborted) {
          seen.aborted = true;
          return { content: [{ type: "text" as const, text: "cancelled" }] };
        }
        if (token !== undefined)
          await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++n } });
        await sleep(Math.min(40, timeoutMs / 3));
      }
      return { content: [{ type: "text" as const, text: `done after ${n} beats` }] };
    },
  );
  const [upC, upS] = InMemoryTransport.createLinkedPair();
  await daemon.connect(upS);
  const upstream = new Client({ name: "fabdesk-core-stdio", version: "0" });
  await upstream.connect(upC);

  const proxy = new Server({ name: "fabdesk", version: "0" }, { capabilities: upstream.getServerCapabilities() ?? {} });
  forwardRequests(proxy, async () => upstream, { projectDir: "/tmp/proj", timeoutMs: () => timeoutMs });
  const [hostC, hostS] = InMemoryTransport.createLinkedPair();
  await proxy.connect(hostS);
  const host = new Client({ name: "claude-code", version: "2.0" });
  await host.connect(hostC);
  return { host, seen, close: async () => Promise.all([host.close(), upstream.close(), daemon.close()]) };
}

describe("stdio proxy request forwarding", () => {
  test("a call longer than the proxy timeout survives on progress, relayed under the host's own token", async () => {
    const { host, seen, close } = await chain(150);
    try {
      const progress: Array<{ progress: number }> = [];
      const res = await host.callTool({ name: "slow", arguments: { ms: 600 } }, undefined, {
        timeout: 10_000,
        onprogress: (p) => void progress.push(p),
      });
      expect(res.isError).toBeFalsy();
      expect((res.content as Array<{ text: string }>)[0]!.text).toMatch(/^done after \d+ beats$/);
      expect(progress.length).toBeGreaterThan(3);
      // The daemon got the proxy's token (its own message id), the project and the host's name.
      expect(seen.meta?.["progressToken"]).toBeDefined();
      expect(seen.meta?.[MCP_CLIENT_META]).toEqual({ name: "claude-code", version: "2.0" });
      expect(seen.args?.["project"]).toBe("/tmp/proj");
    } finally {
      await close();
    }
  });

  test("without a host progressToken the upstream still heartbeats; nothing is relayed", async () => {
    const { host, close } = await chain(150);
    try {
      const res = await host.callTool({ name: "slow", arguments: { ms: 500 } }, undefined, { timeout: 10_000 });
      expect((res.content as Array<{ text: string }>)[0]!.text).toMatch(/^done after/);
    } finally {
      await close();
    }
  });

  test("the host's cancellation aborts the upstream request", async () => {
    const { host, seen, close } = await chain(5_000);
    try {
      const ac = new AbortController();
      const call = host.callTool({ name: "slow", arguments: { ms: 3_000 } }, undefined, { signal: ac.signal });
      await sleep(150);
      ac.abort("stop");
      await expect(call).rejects.toThrow();
      for (let i = 0; i < 50 && !seen.aborted; i++) await sleep(20);
      expect(seen.aborted).toBe(true);
    } finally {
      await close();
    }
  });

  test("tools/call waits the session's durable wait plus a margin; other requests keep the SDK default", () => {
    expect(proxyRequestTimeoutMs("tools/list", { name: "claude-code" })).toBe(DEFAULT_REQUEST_TIMEOUT_MSEC);
    expect(proxyRequestTimeoutMs("tools/call", { name: "claude-code" })).toBeGreaterThan(DURABLE_WAIT_MAX_MS);
    // Unknown hosts get a job id after 50 s: the proxy still outlasts that.
    expect(proxyRequestTimeoutMs("tools/call", { name: "other" })).toBeGreaterThan(50_000 + 60_000);
    expect(proxyRequestTimeoutMs("tools/call", { name: "codex", toolTimeoutSec: 1830 })).toBeGreaterThanOrEqual(1_830_000);
  });
});
