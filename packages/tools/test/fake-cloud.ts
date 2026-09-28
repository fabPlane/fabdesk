/** In-memory fabplane API (the `CloudApi` slice of fabplane-cli's FabplaneClient) for tests. */
import {
  BUILTIN_DESTINATIONS,
  type Cart,
  type CartItem,
  type CartItemInput,
  type Destination,
  type InventoryItem,
  type Org,
} from "@fabdesk/protocol";
import type { CloudApi, CloudApiFactory } from "../src";

export class FakeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "FabplaneApiError";
  }
}

const now = () => new Date().toISOString();

export type FakeCloud = CloudApi & {
  orgs: Org[];
  carts: Map<string, Cart>;
  custom: Destination[];
  inventory: Map<string, InventoryItem>;
  calls: string[];
  tokens: string[];
  lastReplaceSource: string | undefined;
  factory: CloudApiFactory;
};

export function fakeCloud(): FakeCloud {
  let seq = 0;
  const id = (p: string) => `${p}-${++seq}`;
  const orgs: Org[] = [
    {
      id: "org-personal",
      slug: "maya",
      name: "maya's workspace",
      personal: true,
      role: "owner",
      memberCount: 1,
      domainJoin: null,
      createdAt: now(),
    },
    {
      id: "org-team",
      slug: "lab",
      name: "Lab",
      personal: false,
      role: "member",
      memberCount: 4,
      domainJoin: null,
      createdAt: now(),
    },
  ];
  const carts = new Map<string, Cart>();
  const custom: Destination[] = [];
  const inventory = new Map<string, InventoryItem>();
  const calls: string[] = [];
  const tokens: string[] = [];

  const cartOf = (orgId: string, cartId: string): Cart => {
    const c = carts.get(cartId);
    if (!c || c.orgId !== orgId) throw new FakeApiError(404, "not_found");
    return c;
  };
  const toItem = (cart: Cart, input: CartItemInput): CartItem => {
    const { kind, quantity, status, destinationId, ...rest } = input;
    return {
      ...rest,
      id: id("item"),
      kind: kind ?? "part",
      quantity,
      status: status ?? "needed",
      destinationId: destinationId ?? cart.fabDestinationId,
      createdAt: now(),
      updatedAt: now(),
    };
  };
  const touch = (cart: Cart) => {
    cart.itemCount = cart.items.length;
    cart.updatedAt = now();
    const by = new Map<string, { destinationId: string; itemCount: number; totalQuantity: number }>();
    for (const i of cart.items) {
      const b = by.get(i.destinationId) ?? { destinationId: i.destinationId, itemCount: 0, totalQuantity: 0 };
      b.itemCount++;
      b.totalQuantity += i.quantity;
      by.set(i.destinationId, b);
    }
    cart.byDestination = [...by.values()];
  };
  const clone = <T>(v: T): T => structuredClone(v);

  const api: FakeCloud = {
    orgs,
    carts,
    custom,
    inventory,
    calls,
    tokens,
    lastReplaceSource: undefined,
    factory: (o) => {
      tokens.push(o.token);
      return api;
    },
    async listOrgs() {
      calls.push("listOrgs");
      return { orgs: clone(orgs) };
    },
    async listDestinations(orgId) {
      calls.push(`listDestinations ${orgId}`);
      return { destinations: [...BUILTIN_DESTINATIONS, ...custom] };
    },
    async createDestination(orgId, body) {
      calls.push(`createDestination ${orgId}`);
      const d: Destination = {
        id: id("dest"),
        name: body.name,
        kind: body.kind ?? "distributor",
        url: body.url,
        builtin: false,
        baseId: body.baseId ?? null,
      };
      custom.push(d);
      return { destination: d };
    },
    async listCarts(orgId, query) {
      calls.push(`listCarts ${orgId} ${query?.projectId ?? ""}`);
      return {
        carts: [...carts.values()]
          .filter((c) => c.orgId === orgId && (!query?.projectId || c.projectId === query.projectId))
          .map(({ items: _i, notes: _n, byDestination: _b, ...summary }) => clone(summary)),
      };
    },
    async createCart(orgId, body) {
      calls.push(`createCart ${orgId}`);
      const cart: Cart = {
        id: id("cart"),
        orgId,
        name: body.name,
        repos: body.repos ?? [],
        projectId: body.projectId ?? null,
        fabDestinationId: body.fabDestinationId ?? "builtin:jlcpcb",
        itemCount: 0,
        createdAt: now(),
        updatedAt: now(),
        notes: body.notes ?? null,
        items: [],
        byDestination: [],
      };
      carts.set(cart.id, cart);
      return { cart: clone(cart) };
    },
    async getCart(orgId, cartId) {
      calls.push(`getCart ${cartId}`);
      return { cart: clone(cartOf(orgId, cartId)) };
    },
    async updateCart(orgId, cartId, patch) {
      const cart = cartOf(orgId, cartId);
      Object.assign(cart, patch);
      touch(cart);
      return { cart: clone(cart) };
    },
    async addCartItems(orgId, cartId, items) {
      calls.push(`addCartItems ${cartId} ${items.length}`);
      const cart = cartOf(orgId, cartId);
      const added = items.map((i) => toItem(cart, i));
      cart.items.push(...added);
      touch(cart);
      return { items: clone(added) };
    },
    async replaceCartItems(orgId, cartId, items, source) {
      calls.push(`replaceCartItems ${cartId} ${items.length}`);
      api.lastReplaceSource = source;
      const cart = cartOf(orgId, cartId);
      cart.items = items.map((i) => toItem(cart, i));
      touch(cart);
      return { cart: clone(cart) };
    },
    async updateCartItem(orgId, cartId, itemId, patch) {
      calls.push(`updateCartItem ${itemId}`);
      const cart = cartOf(orgId, cartId);
      const item = cart.items.find((i) => i.id === itemId);
      if (!item) throw new FakeApiError(404, "not_found");
      Object.assign(item, patch, { updatedAt: now() });
      touch(cart);
      return { item: clone(item) };
    },
    async deleteCartItem(orgId, cartId, itemId) {
      calls.push(`deleteCartItem ${itemId}`);
      const cart = cartOf(orgId, cartId);
      const before = cart.items.length;
      cart.items = cart.items.filter((i) => i.id !== itemId);
      if (cart.items.length === before) throw new FakeApiError(404, "not_found");
      touch(cart);
    },
    async listInventory(orgId, query) {
      calls.push(`listInventory ${orgId} ${query?.q ?? ""}`);
      const q = query?.q?.toLowerCase();
      const items = [...inventory.values()].filter(
        (i) =>
          i.orgId === orgId &&
          (!q || [i.name, i.mpn, i.manufacturer, i.description, i.sku].some((f) => f?.toLowerCase().includes(q))),
      );
      return { items: clone(items), nextCursor: null };
    },
    async createInventoryItem(orgId, input, images) {
      calls.push(`createInventoryItem ${orgId} images=${images?.length ?? 0}`);
      if (input.serverAiProcessing)
        throw new FakeApiError(501, "server_ai_unavailable", "Server-side AI processing is not available yet");
      const { serverAiProcessing: _s, ...rest } = input;
      const item: InventoryItem = {
        ...rest,
        id: id("inv"),
        orgId,
        quantity: input.quantity ?? 0,
        unit: input.unit ?? "pcs",
        tags: input.tags ?? [],
        attributes: input.attributes ?? {},
        images: (images ?? []).map((img) => ({
          id: id("img"),
          contentType: img.contentType,
          bytes: img.data instanceof Blob ? img.data.size : img.data.byteLength,
          url: `https://files.example/${img.filename}`,
          createdAt: now(),
        })),
        createdBy: "user-1",
        createdAt: now(),
        updatedAt: now(),
      };
      inventory.set(item.id, item);
      return { item: clone(item) };
    },
    async getInventoryItem(orgId, itemId) {
      const item = inventory.get(itemId);
      if (!item || item.orgId !== orgId) throw new FakeApiError(404, "not_found");
      return { item: clone(item) };
    },
    async updateInventoryItem(orgId, itemId, patch) {
      const item = inventory.get(itemId);
      if (!item || item.orgId !== orgId) throw new FakeApiError(404, "not_found");
      Object.assign(item, patch);
      return { item: clone(item) };
    },
    async adjustInventory(orgId, itemId, delta) {
      calls.push(`adjustInventory ${itemId} ${delta}`);
      const item = inventory.get(itemId);
      if (!item || item.orgId !== orgId) throw new FakeApiError(404, "not_found");
      if (item.quantity + delta < 0) throw new FakeApiError(409, "conflict", "quantity would be negative");
      item.quantity += delta;
      return { item: clone(item) };
    },
    async uploadInventoryImage(orgId, itemId, image) {
      const item = inventory.get(itemId);
      if (!item || item.orgId !== orgId) throw new FakeApiError(404, "not_found");
      const img = { id: id("img"), contentType: image.contentType, bytes: 1, url: "https://files.example/x", createdAt: now() };
      item.images.push(img);
      return { image: img };
    },
  };
  return api;
}
