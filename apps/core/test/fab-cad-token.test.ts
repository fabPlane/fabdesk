/**
 * The fab_cad bridge token (`FABDESK_FAB_CAD_BRIDGE_TOKEN`): sent as a bearer on every HTTP call
 * and on the `/ws` upgrade, never in a URL, and not at all when unset.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { fabCadBridgeToken } from "../src/config";
import { createFabCad } from "../src/fab-cad";
import { FabCadBridgeClient } from "../src/fab-cad-bridge";

type Seen = { method: string; path: string; authorization: string | null; upgrade: boolean };

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** A bridge stand-in that records what reaches it; `/ws` upgrades and then closes at once. */
function fakeBridge() {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      const upgrade = url.pathname === "/ws";
      seen.push({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        authorization: req.headers.get("authorization"),
        upgrade,
      });
      if (upgrade && srv.upgrade(req, { data: null })) return undefined;
      if (url.pathname === "/health")
        return Response.json({ ok: true, name: "@fab-cad/bridge", sessions: [] });
      if (url.pathname === "/sessions" && req.method === "POST")
        return Response.json({ session: { id: "s1", state: "running", path: null } });
      return Response.json({ sessions: [] });
    },
    websocket: {
      open(ws) {
        ws.close(1011, "test bridge");
      },
      message() {},
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

describe("fab_cad bridge token", () => {
  test("is read from FABDESK_FAB_CAD_BRIDGE_TOKEN, blank meaning none", () => {
    expect(fabCadBridgeToken({ FABDESK_FAB_CAD_BRIDGE_TOKEN: " abc " })).toBe("abc");
    expect(fabCadBridgeToken({ FABDESK_FAB_CAD_BRIDGE_TOKEN: "  " })).toBeNull();
    expect(fabCadBridgeToken({})).toBeNull();
  });

  test("HTTP calls carry the bearer when set, and no Authorization when not", async () => {
    const bridge = fakeBridge();
    const withToken = new FabCadBridgeClient({ url: bridge.url, token: "tok-123" });
    await withToken.health();
    await withToken.sessions();
    const without = new FabCadBridgeClient({ url: bridge.url });
    await without.sessions();
    expect(bridge.seen.map((s) => s.authorization)).toEqual([
      "Bearer tok-123",
      "Bearer tok-123",
      null,
    ]);
    // The WebSocket URL handed out (cad_view, the web UI) never carries the token.
    expect(withToken.wsUrl("s1")).not.toContain("tok-123");
    expect(withToken.wsUrl("s1")).toBe(`${bridge.url.replace("http", "ws")}/ws?session=s1`);
  });

  for (const token of ["tok-ws", null] as const) {
    test(`the /ws upgrade ${token ? "carries the bearer header" : "sends no Authorization"}`, async () => {
      const bridge = fakeBridge();
      const client = new FabCadBridgeClient({ url: bridge.url, token });
      const cad = createFabCad({
        bridge: () => client,
        exists: async () => false,
        clientName: "fabdesk/test",
      });
      // The stand-in closes the socket straight away, so the call fails; the upgrade is what counts.
      await cad.python("/tmp/fabdesk-token-test", "1", "eval").catch(() => undefined);
      await cad.dispose();
      const upgrades = bridge.seen.filter((s) => s.upgrade);
      expect(upgrades.length).toBeGreaterThan(0);
      for (const u of upgrades) {
        expect(u.authorization).toBe(token ? `Bearer ${token}` : null);
        expect(u.path).not.toContain("tok-ws");
      }
    });
  }
});
