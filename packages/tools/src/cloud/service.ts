/**
 * fabplane.com carts and inventory for fabdesk: resolves the active org (Settings.cloudOrgId, else
 * the personal org) and a project's shopping list — the org cart whose `projectId` is the fabdesk
 * project id, created on first use. Shared by fabdesk-core's HTTP routes and the `shopping` tools.
 */
import { join } from "node:path";
import {
  DEFAULT_FAB_DESTINATION,
  NetlistFile,
  ProjectPartsFile,
  cartDashboardUrl,
  dashboardUrlFor,
  emptyProjectParts,
  type BomSyncSummary,
  type Cart,
  type CartItem,
  type CartItemInput,
  type CartItemPatch,
  type CloudStatus,
  type CreateDestinationInput,
  type Destination,
  type InventoryItem,
  type InventoryItemInput,
  type InventoryQuery,
  type Org,
  type ShoppingListResponse,
} from "@fabdesk/protocol";
import { PROJECT_FILES, readJsonIfPresent, readJsonOrNull } from "../fs";
import { ToolError } from "../registry";
import {
  CloudSignedOutError,
  CloudUnavailableError,
  cloudToolError,
  type CloudApi,
  type CloudApiFactory,
  type CloudImageUpload,
} from "./api";
import { BOM_SOURCE, bomLinesFromNetlist, bomLinesFromOffboard, mergeBomItems } from "./bom";
import { gitRemotes } from "./git";

/** What the service needs to know about a project. `ProjectHandle` satisfies it. */
export type CloudProject = { id: string; name: string; dir: string };

export type CloudServiceOptions = {
  apiOrigin: string;
  /** fabplane bearer (device or personal token); null while signed out. */
  token: () => string | null;
  /** Current `Settings.cloudOrgId`. */
  orgSetting: () => string | null | undefined;
  /** Null when this build has no fabplane client. */
  api: CloudApiFactory | null;
  /** How long the resolved org list is reused. */
  orgTtlMs?: number;
};

export class CloudService {
  private clientMemo: { token: string; api: CloudApi } | null = null;
  private orgMemo: { token: string; at: number; orgs: Org[] } | null = null;

  constructor(private readonly opts: CloudServiceOptions) {}

  get dashboardUrl(): string {
    return dashboardUrlFor(this.opts.apiOrigin);
  }

  get available(): boolean {
    return this.opts.api !== null;
  }

  signedIn(): boolean {
    return !!this.opts.token();
  }

  /** The API client for the current token. Throws while signed out or when unavailable. */
  client(): CloudApi {
    if (!this.opts.api) throw new CloudUnavailableError();
    const token = this.opts.token();
    if (!token) throw new CloudSignedOutError();
    if (this.clientMemo?.token !== token)
      this.clientMemo = { token, api: this.opts.api({ origin: this.opts.apiOrigin, token }) };
    return this.clientMemo.api;
  }

  /** Runs `fn` against the API. fabplane errors propagate unchanged (`FabplaneApiError`). */
  private call<T>(fn: (api: CloudApi) => Promise<T>): Promise<T> {
    return fn(this.client());
  }

  async orgs(fresh = false): Promise<Org[]> {
    const token = this.opts.token();
    const ttl = this.opts.orgTtlMs ?? 60_000;
    if (
      !fresh &&
      token &&
      this.orgMemo?.token === token &&
      Date.now() - this.orgMemo.at < ttl
    )
      return this.orgMemo.orgs;
    const { orgs } = await this.call((api) => api.listOrgs());
    if (token) this.orgMemo = { token, at: Date.now(), orgs };
    return orgs;
  }

  /** Settings.cloudOrgId when the caller is still a member, else the personal org. */
  async activeOrgId(): Promise<string> {
    const orgs = await this.orgs();
    const wanted = this.opts.orgSetting();
    const chosen =
      (wanted ? orgs.find((o) => o.id === wanted) : undefined) ??
      orgs.find((o) => o.personal) ??
      orgs[0];
    if (!chosen) throw new ToolError("fabplane.com returned no orgs for this account", "precondition");
    return chosen.id;
  }

  async status(): Promise<CloudStatus> {
    const base = { available: this.available, dashboardUrl: this.dashboardUrl };
    if (!this.available || !this.signedIn())
      return { ...base, signedIn: false, orgs: [], activeOrgId: null };
    try {
      const orgs = await this.orgs(true);
      return { ...base, signedIn: true, orgs, activeOrgId: await this.activeOrgId() };
    } catch (e) {
      const err = cloudToolError(e);
      return {
        ...base,
        signedIn: true,
        orgs: [],
        activeOrgId: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /* ---------- shopping lists ---------- */

  private async findCart(orgId: string, project: CloudProject): Promise<Cart | null> {
    const { carts } = await this.call((api) => api.listCarts(orgId, { projectId: project.id }));
    const summary = carts.find((c) => c.projectId === project.id);
    if (!summary) return null;
    return (await this.call((api) => api.getCart(orgId, summary.id))).cart;
  }

  private cartUrl(cart: Cart | null): string | null {
    return cart ? cartDashboardUrl(this.dashboardUrl, cart.id) : null;
  }

  async shoppingList(project: CloudProject): Promise<ShoppingListResponse> {
    const orgId = await this.activeOrgId();
    const cart = await this.findCart(orgId, project);
    return { orgId, cart, cartUrl: this.cartUrl(cart) };
  }

  /** The project's cart, created (named after the project, tagged with its git remotes) if missing. */
  async ensureShoppingList(
    project: CloudProject,
  ): Promise<ShoppingListResponse & { cart: Cart; created: boolean }> {
    const orgId = await this.activeOrgId();
    const existing = await this.findCart(orgId, project);
    if (existing) return { orgId, cart: existing, cartUrl: this.cartUrl(existing), created: false };
    const repos = (await gitRemotes(project.dir)).slice(0, 20);
    const { cart } = await this.call((api) =>
      api.createCart(orgId, {
        name: project.name.slice(0, 120) || project.id,
        projectId: project.id,
        ...(repos.length ? { repos } : {}),
      }),
    );
    return { orgId, cart, cartUrl: this.cartUrl(cart), created: true };
  }

  private async requireCart(project: CloudProject): Promise<{ orgId: string; cart: Cart }> {
    const orgId = await this.activeOrgId();
    const cart = await this.findCart(orgId, project);
    if (!cart)
      throw new ToolError(
        `project "${project.name}" has no shopping list yet; add items or sync the BOM to create one`,
        "not_found",
      );
    return { orgId, cart };
  }

  async addItems(
    project: CloudProject,
    items: CartItemInput[],
  ): Promise<{ cart: Cart; added: CartItem[]; cartUrl: string }> {
    const { orgId, cart } = await this.ensureShoppingList(project);
    const { items: added } = await this.call((api) => api.addCartItems(orgId, cart.id, items));
    const fresh = (await this.call((api) => api.getCart(orgId, cart.id))).cart;
    return { cart: fresh, added, cartUrl: cartDashboardUrl(this.dashboardUrl, fresh.id) };
  }

  async updateItem(project: CloudProject, itemId: string, patch: CartItemPatch): Promise<CartItem> {
    const { orgId, cart } = await this.requireCart(project);
    return (await this.call((api) => api.updateCartItem(orgId, cart.id, itemId, patch))).item;
  }

  async removeItem(project: CloudProject, itemId: string): Promise<void> {
    const { orgId, cart } = await this.requireCart(project);
    await this.call((api) => api.deleteCartItem(orgId, cart.id, itemId));
  }

  /** Rebuild the part lines from the netlist and `project.parts.json`, keeping user edits. */
  async syncBom(
    project: CloudProject,
  ): Promise<{ cart: Cart; summary: BomSyncSummary; cartUrl: string }> {
    const netlist = await readNetlistOrNull(project);
    const offboard = await readProjectParts(project);
    const { orgId, cart } = await this.ensureShoppingList(project);
    const fab = cart.fabDestinationId || DEFAULT_FAB_DESTINATION;
    const fresh = [
      ...bomLinesFromNetlist(netlist?.netlist.components ?? [], { destinationId: fab }),
      ...bomLinesFromOffboard(offboard.parts, { destinationId: fab }),
    ];
    if (fresh.length === 0 && !netlist && offboard.parts.length === 0) {
      throw new ToolError(
        `${PROJECT_FILES.netlistJson} not found in project "${project.name}"; write the netlist or add off-board parts first`,
        "precondition",
      );
    }
    const { items, summary } = mergeBomItems(fresh, cart.items, {
      projectName: project.name,
      fabDestinationId: fab,
    });
    const next = (await this.call((api) => api.replaceCartItems(orgId, cart.id, items, BOM_SOURCE)))
      .cart;
    return { cart: next, summary, cartUrl: cartDashboardUrl(this.dashboardUrl, next.id) };
  }

  /* ---------- destinations ---------- */

  async destinations(): Promise<Destination[]> {
    const orgId = await this.activeOrgId();
    return (await this.call((api) => api.listDestinations(orgId))).destinations;
  }

  async addDestination(input: CreateDestinationInput): Promise<Destination> {
    const orgId = await this.activeOrgId();
    return (await this.call((api) => api.createDestination(orgId, input))).destination;
  }

  /* ---------- inventory ---------- */

  async searchInventory(
    query: InventoryQuery = {},
  ): Promise<{ items: InventoryItem[]; nextCursor: string | null }> {
    const orgId = await this.activeOrgId();
    return this.call((api) => api.listInventory(orgId, query));
  }

  /** Never asks the server to run AI: semi-structured fields come from the local agent. */
  async addInventoryItem(
    input: InventoryItemInput,
    images?: CloudImageUpload[],
  ): Promise<InventoryItem> {
    const orgId = await this.activeOrgId();
    const { serverAiProcessing: _ignored, ...rest } = input;
    const body: InventoryItemInput = { source: "fabdesk", ...rest };
    return (
      await this.call((api) =>
        images?.length ? api.createInventoryItem(orgId, body, images) : api.createInventoryItem(orgId, body),
      )
    ).item;
  }

  async adjustInventory(itemId: string, delta: number, reason?: string): Promise<InventoryItem> {
    const orgId = await this.activeOrgId();
    return (
      await this.call((api) =>
        reason ? api.adjustInventory(orgId, itemId, delta, reason) : api.adjustInventory(orgId, itemId, delta),
      )
    ).item;
  }
}

export async function readNetlist(project: CloudProject): Promise<NetlistFile> {
  const file = await readNetlistOrNull(project);
  if (file === null)
    throw new ToolError(
      `${PROJECT_FILES.netlistJson} not found in project "${project.name}"; build the circuit first`,
      "precondition",
    );
  return file;
}

export async function readNetlistOrNull(project: CloudProject): Promise<NetlistFile | null> {
  const raw = await readJsonOrNull<unknown>(join(project.dir, PROJECT_FILES.netlistJson));
  if (raw === null) return null;
  const parsed = NetlistFile.safeParse(raw);
  if (!parsed.success)
    throw new ToolError(`${PROJECT_FILES.netlistJson} is not a valid netlist`, "precondition");
  return parsed.data;
}

export async function readProjectParts(project: CloudProject): Promise<ProjectPartsFile> {
  let raw: unknown;
  try {
    raw = await readJsonIfPresent<unknown>(join(project.dir, PROJECT_FILES.projectParts));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new ToolError(`${PROJECT_FILES.projectParts} is not valid JSON: ${msg}`, "precondition");
  }
  if (raw === null) return emptyProjectParts();
  const parsed = ProjectPartsFile.safeParse(raw);
  if (!parsed.success)
    throw new ToolError(`${PROJECT_FILES.projectParts} is not valid`, "precondition");
  return parsed.data;
}
