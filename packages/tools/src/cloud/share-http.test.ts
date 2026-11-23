import { expect, test } from "bun:test";
import type { CloudApi } from "./api";
import { withProjectShareHttp } from "./share-http";

test("adds share HTTP methods when the vendored client does not expose them", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    return new Response(
      JSON.stringify({
        visibility: "unlisted",
        shareId: "share_0123456789abcdef",
        publishedAt: "2026-11-11T00:00:00.000Z",
        revision: "r1",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const api = withProjectShareHttp({} as CloudApi, { origin: "https://api.fabplane.com", token: "tok" });
    const published = await api.publishProjectShare!("desk-1", { schema: "fabplane.project-share.v1" }, "unlisted");
    expect((published as { shareId: string }).shareId).toBe("share_0123456789abcdef");
    expect(calls[0]?.url).toContain("/v1/private/projects/desk-1/share?visibility=unlisted");
    expect(calls[0]?.method).toBe("PUT");
  } finally {
    globalThis.fetch = original;
  }
});

test("keeps prototype methods on a class-based cloud client", () => {
  class FakeClient {
    listOrgs() {
      return { orgs: [{ id: "org_1" }] };
    }
    listCarts() {
      return { carts: [] };
    }
    listInventory() {
      return { items: [], nextCursor: null };
    }
  }
  const wrapped = withProjectShareHttp(new FakeClient() as unknown as CloudApi, {
    origin: "https://api.fabplane.com",
    token: "t",
  });
  expect(typeof wrapped.getProjectShare).toBe("function");
  expect(typeof wrapped.publishProjectShare).toBe("function");
  const client = wrapped as unknown as FakeClient;
  expect(client.listOrgs()).toEqual({ orgs: [{ id: "org_1" }] });
  expect(client.listCarts()).toEqual({ carts: [] });
  expect(client.listInventory()).toEqual({ items: [], nextCursor: null });
});

test("keeps an existing client implementation", () => {
  const existing = {
    listOrgs: async () => ({ orgs: [] }),
    listDestinations: async () => ({ destinations: [] }),
    createDestination: async () => ({ destination: {} }),
    listCarts: async () => ({ carts: [] }),
    createCart: async () => ({ cart: {} }),
    getCart: async () => ({ cart: {} }),
    updateCart: async () => ({ cart: {} }),
    addCartItems: async () => ({ items: [] }),
    replaceCartItems: async () => ({ cart: {} }),
    updateCartItem: async () => ({ item: {} }),
    deleteCartItem: async () => undefined,
    listInventory: async () => ({ items: [], nextCursor: null }),
    createInventoryItem: async () => ({ item: {} }),
    getInventoryItem: async () => ({ item: {} }),
    updateInventoryItem: async () => ({ item: {} }),
    adjustInventory: async () => ({ item: {} }),
    uploadInventoryImage: async () => ({ image: {} }),
    getProjectShare: async () => ({ visibility: "private" as const }),
    publishProjectShare: async () => ({ visibility: "private" as const }),
    disableProjectShare: async () => ({ visibility: "private" as const }),
    getSharedProject: async () => ({}),
    getSharedProjectStatus: async () => ({}),
  } as unknown as CloudApi;
  expect(withProjectShareHttp(existing, { origin: "https://api.fabplane.com", token: "t" })).toBe(existing);
});
