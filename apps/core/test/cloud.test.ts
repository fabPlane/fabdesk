import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cart, CloudStatus, InventoryItem, ShoppingListResponse } from "@fabdesk/protocol";
import type { CoreServices } from "@fabdesk/tools";
import { serve, type Daemon } from "../src/serve";
import { createCloudService } from "../src/cloud";
import { mockServices } from "../../../packages/tools/test/mock-services";
import { FakeApiError, fakeCloud, type FakeCloud } from "../../../packages/tools/test/fake-cloud";

let daemon: Daemon;
let home: string;
let api: FakeCloud;
let token: string | null = "fpd_route_test";

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "fabdesk-cloud-"));
  process.env["FABDESK_PROJECTS_DIR"] = join(home, "Fabdesk");
  process.env["FABDESK_TOKEN"] = "test-token-0123456789abcdef";
  process.env["FABDESK_CHANNEL"] = "internal";
  api = fakeCloud();
  daemon = await serve({
    port: 0,
    dataDir: home,
    handshakeFile: join(home, "daemon.json"),
    localAuth: true,
    parentPid: process.pid,
    quiet: true,
    watchProjects: false,
    services: async ({ projects, bus, store }) =>
      mockServices([], {
        projects,
        bus: { emit: (e) => bus.emit(e) },
        routeRuns: store.routeRuns,
        channel: "internal",
        settings: () => store.settings.get(),
        cloud: createCloudService({
          apiOrigin: "http://fabplane-staging.tail4f6a7.ts.net:4000",
          token: () => token,
          settings: () => store.settings.get(),
          api: api.factory,
        }),
      }) as unknown as CoreServices,
    doctor: async () => ({
      version: "t",
      channel: "internal",
      bun: Bun.version,
      platform: "test",
      kicad: { found: false },
      ngspice: { found: false },
      routers: [],
      agents: [],
      warnings: [],
    }),
  });
});

afterAll(async () => {
  await daemon.close("tests done");
});

const api_ = (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const { json, ...rest } = init;
  return fetch(`${daemon.url}${path}`, {
    ...rest,
    headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
};

const NETLIST = {
  netlist: {
    components: [
      { ref: "R2", value: "10k", footprint: "R_0603" },
      { ref: "R1", value: "10k", footprint: "R_0603" },
      { ref: "C1", value: "100nF", footprint: "C_0402", fields: { MPN: "CL05B104KO5NNNC", LCSC: "C1525" } },
      { ref: "#PWR01", value: "GND", footprint: "" },
    ],
    nets: [],
  },
};

async function newProject(name: string): Promise<{ id: string; path: string }> {
  const res = await api_("/projects", { method: "POST", json: { name } });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; path: string };
}

describe("cloud routes", () => {
  test("status reports orgs, the active org and the dashboard URL; the org setting switches it", async () => {
    const status = (await (await api_("/cloud/status")).json()) as CloudStatus;
    expect(status).toMatchObject({
      available: true,
      signedIn: true,
      activeOrgId: "org-personal",
      dashboardUrl: "http://fabplane-staging.tail4f6a7.ts.net:5173/dashboard",
    });
    expect(status.orgs.map((o) => o.id)).toEqual(["org-personal", "org-team"]);
    expect(api.tokens).toContain("fpd_route_test");

    const patched = await api_("/settings", { method: "PATCH", json: { cloudOrgId: "org-team" } });
    expect(((await patched.json()) as { cloudOrgId: string }).cloudOrgId).toBe("org-team");
    expect(((await (await api_("/cloud/status")).json()) as CloudStatus).activeOrgId).toBe("org-team");
    await api_("/settings", { method: "PATCH", json: { cloudOrgId: null } });
  });

  test("shopping list: none yet, create with git remotes, sync BOM, edit, delete", async () => {
    const p = await newProject("Cart Board");
    const none = (await (await api_(`/projects/${p.id}/shopping-list`)).json()) as ShoppingListResponse;
    expect(none).toEqual({ orgId: "org-personal", cart: null, cartUrl: null });

    await mkdir(join(p.path, ".git"), { recursive: true });
    await writeFile(join(p.path, ".git", "config"), '[remote "origin"]\n\turl = https://x:secret@github.com/acme/cart-board.git\n');
    const created = await api_(`/projects/${p.id}/shopping-list`, { method: "POST" });
    expect(created.status).toBe(201);
    const list = (await created.json()) as ShoppingListResponse & { cart: Cart };
    expect(list.cart).toMatchObject({ name: "Cart Board", projectId: p.id, repos: ["https://github.com/acme/cart-board.git"] });
    expect(list.cartUrl).toBe(`http://fabplane-staging.tail4f6a7.ts.net:5173/dashboard/carts/${list.cart.id}`);
    expect((await api_(`/projects/${p.id}/shopping-list`, { method: "POST" })).status).toBe(200);

    const noNetlist = await api_(`/projects/${p.id}/shopping-list/sync-bom`, { method: "POST" });
    expect(noNetlist.status).toBe(412);

    await writeFile(join(p.path, "circuit.netlist.json"), JSON.stringify(NETLIST));
    expect((await api_(`/projects/${p.id}/shopping-list/sync-bom`, { method: "POST" })).status).toBe(412);
    expect((await api_(`/projects/${p.id}/shopping-list/sync-bom`, { method: "POST", json: { allowPartial: true, expectedRevision: "0".repeat(64) } })).status).toBe(412);
    expect((await api_(`/projects/${p.id}/shopping-list/sync-bom`, { method: "POST", body: "{" })).status).toBe(400);
    const synced = (await (await api_(`/projects/${p.id}/shopping-list/sync-bom`, { method: "POST", json: { allowPartial: true } })).json()) as {
      cart: Cart;
      summary: { parts: number; pcbAdded: boolean };
    };
    expect(synced.summary).toMatchObject({ parts: 2, pcbAdded: true });
    expect(synced.cart.items.map((i) => [i.kind, i.refs ?? [], i.quantity, i.sku ?? null])).toEqual([
      ["pcb", [], 5, null],
      ["part", ["C1"], 1, "C1525"],
      ["part", ["R1", "R2"], 2, null],
    ]);
    expect(api.lastReplaceSource).toBe("fabdesk-bom");

    const resistor = synced.cart.items.find((i) => i.value === "10k")!;
    const patched = await api_(`/projects/${p.id}/shopping-list/items/${resistor.id}`, {
      method: "PATCH",
      json: { destinationId: "builtin:manual", status: "received" },
    });
    expect(((await patched.json()) as { item: { status: string } }).item.status).toBe("received");
    expect(
      (await api_(`/projects/${p.id}/shopping-list/items/${resistor.id}`, { method: "PATCH", json: { quantity: -2 } })).status,
    ).toBe(400);

    const added = await api_(`/projects/${p.id}/shopping-list/items`, {
      method: "POST",
      json: { items: [{ kind: "other", description: "Stencil", quantity: 1 }] },
    });
    expect(added.status).toBe(201);
    const resync = (await (await api_(`/projects/${p.id}/shopping-list/sync-bom`, { method: "POST", json: { allowPartial: true } })).json()) as { cart: Cart };
    expect(resync.cart.items.find((i) => i.value === "10k")).toMatchObject({ destinationId: "builtin:manual", status: "received" });
    expect(resync.cart.items.some((i) => i.description === "Stencil")).toBe(true);

    const del = await api_(`/projects/${p.id}/shopping-list/items/${resistor.id}`, { method: "DELETE" });
    expect(del.status).toBe(404); // the resync replaced the item ids
    const current = resync.cart.items.find((i) => i.description === "Stencil")!;
    expect((await api_(`/projects/${p.id}/shopping-list/items/${current.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api_(`/projects/nope/shopping-list`)).status).toBe(404);
  });

  test("destinations and inventory (JSON and multipart)", async () => {
    const dests = (await (await api_("/cloud/destinations")).json()) as { destinations: { id: string }[] };
    expect(dests.destinations[0]!.id).toBe("builtin:jlcpcb");
    const custom = await api_("/cloud/destinations", {
      method: "POST",
      json: { name: "DigiKey Thailand", url: "https://www.digikey.co.th", baseId: "builtin:digikey" },
    });
    expect(custom.status).toBe(201);

    const created = await api_("/cloud/inventory", {
      method: "POST",
      json: { name: "LM358", mpn: "LM358DR", quantity: 3, serverAiProcessing: true },
    });
    expect(created.status).toBe(201);
    const item = ((await created.json()) as { item: InventoryItem }).item;
    expect(item).toMatchObject({ name: "LM358", quantity: 3, source: "fabdesk" });

    const form = new FormData();
    form.set("item", JSON.stringify({ name: "Photo part", quantity: 1 }));
    form.append("image", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "p.png", { type: "image/png" }));
    const multi = await fetch(`${daemon.url}/cloud/inventory`, {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.token}` },
      body: form,
    });
    expect(multi.status).toBe(201);
    expect(((await multi.json()) as { item: InventoryItem }).item.images).toHaveLength(1);

    const found = (await (await api_("/cloud/inventory?q=lm35")).json()) as { items: InventoryItem[] };
    expect(found.items.map((i) => i.id)).toEqual([item.id]);

    const adj = await api_(`/cloud/inventory/${item.id}/adjust`, { method: "POST", json: { delta: -2, reason: "used" } });
    expect(((await adj.json()) as { item: InventoryItem }).item.quantity).toBe(1);
    const over = await api_(`/cloud/inventory/${item.id}/adjust`, { method: "POST", json: { delta: -5 } });
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ error: "conflict" });
    expect((await api_(`/cloud/inventory/${item.id}/adjust`, { method: "POST", json: { delta: 0 } })).status).toBe(400);
  });

  test("signed out → 401 cloud_signed_out; a rejected fabplane token too", async () => {
    token = null;
    try {
      const status = (await (await api_("/cloud/status")).json()) as CloudStatus;
      expect(status).toMatchObject({ available: true, signedIn: false, orgs: [] });
      const res = await api_("/cloud/inventory");
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "cloud_signed_out" });
    } finally {
      token = "fpd_route_test";
    }
    const { listOrgs, listDestinations } = api;
    api.listDestinations = async () => {
      throw new FakeApiError(401, "unauthorized", "token revoked");
    };
    api.listOrgs = async () => {
      throw new FakeApiError(401, "unauthorized", "token revoked");
    };
    try {
      const res = await api_("/cloud/destinations");
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "cloud_signed_out", message: "token revoked" });
      const status = (await (await api_("/cloud/status")).json()) as CloudStatus;
      expect(status.error).toContain("Sign in to fabplane");
    } finally {
      api.listOrgs = listOrgs;
      api.listDestinations = listDestinations;
    }
  });
});
