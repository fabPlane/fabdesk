/**
 * The slice of `fabplane-cli`'s `FabplaneClient` fabdesk uses. Method names, argument order and
 * return envelopes match the client exactly (it returns the response body as the API contract
 * documents it; 204s resolve to undefined), so a `FabplaneClient` instance satisfies `CloudApi`.
 */
import type {
  Cart,
  CartItem,
  CartItemInput,
  CartItemPatch,
  CartSummary,
  CreateCartInput,
  CreateDestinationInput,
  Destination,
  InventoryImage,
  InventoryItem,
  InventoryItemInput,
  InventoryQuery,
  Org,
  UpdateCartInput,
} from "@fabdesk/protocol";
import { ToolError } from "../registry";

export type CloudImageUpload = { data: Uint8Array | Blob; contentType: string; filename: string };

export interface CloudApi {
  // Optional for older clients: unsupported builds fail closed rather than pretending to publish.
  getProjectShare?(projectId: string): Promise<unknown>;
  publishProjectShare?(projectId: string, snapshot: unknown): Promise<unknown>;
  disableProjectShare?(projectId: string): Promise<unknown>;
  getSharedProject?(shareId: string): Promise<unknown>;
  getSharedProjectStatus?(shareId:string):Promise<unknown>;
  listOrgs(): Promise<{ orgs: Org[] }>;
  listDestinations(orgId: string): Promise<{ destinations: Destination[] }>;
  createDestination(
    orgId: string,
    body: CreateDestinationInput,
  ): Promise<{ destination: Destination }>;
  listCarts(
    orgId: string,
    query?: { repo?: string; projectId?: string },
  ): Promise<{ carts: CartSummary[] }>;
  createCart(orgId: string, body: CreateCartInput): Promise<{ cart: Cart }>;
  getCart(orgId: string, cartId: string): Promise<{ cart: Cart }>;
  updateCart(orgId: string, cartId: string, patch: UpdateCartInput): Promise<{ cart: Cart }>;
  addCartItems(
    orgId: string,
    cartId: string,
    items: CartItemInput[],
  ): Promise<{ items: CartItem[] }>;
  replaceCartItems(
    orgId: string,
    cartId: string,
    items: CartItemInput[],
    source?: string,
  ): Promise<{ cart: Cart }>;
  updateCartItem(
    orgId: string,
    cartId: string,
    itemId: string,
    patch: CartItemPatch,
  ): Promise<{ item: CartItem }>;
  deleteCartItem(orgId: string, cartId: string, itemId: string): Promise<void>;
  listInventory(
    orgId: string,
    query?: InventoryQuery,
  ): Promise<{ items: InventoryItem[]; nextCursor: string | null }>;
  createInventoryItem(
    orgId: string,
    input: InventoryItemInput,
    images?: CloudImageUpload[],
  ): Promise<{ item: InventoryItem }>;
  getInventoryItem(orgId: string, itemId: string): Promise<{ item: InventoryItem }>;
  updateInventoryItem(
    orgId: string,
    itemId: string,
    patch: Partial<InventoryItemInput>,
  ): Promise<{ item: InventoryItem }>;
  adjustInventory(
    orgId: string,
    itemId: string,
    delta: number,
    reason?: string,
  ): Promise<{ item: InventoryItem }>;
  uploadInventoryImage(
    orgId: string,
    itemId: string,
    image: CloudImageUpload,
  ): Promise<{ image: InventoryImage }>;
}

/** How fabdesk-core builds a client: `(o) => new FabplaneClient(o)` once fabplane-cli is vendored. */
export type CloudApiFactory = (o: { origin: string; token: string }) => CloudApi;

/** `FabplaneApiError { status, code, message, body }`, matched structurally. */
export type CloudApiErrorLike = Error & { status: number; code: string; body?: unknown };

export function isCloudApiError(e: unknown): e is CloudApiErrorLike {
  return (
    e instanceof Error &&
    typeof (e as { status?: unknown }).status === "number" &&
    typeof (e as { code?: unknown }).code === "string"
  );
}

export const CLOUD_SIGNED_OUT_MESSAGE =
  "Not signed in to fabplane.com. Sign in to fabplane (Settings → Account in the fabPlane app) to use shopping lists and team inventory.";

/** No fabplane token: the daemon runs signed out (or in local auth mode). */
export class CloudSignedOutError extends ToolError {
  constructor() {
    super(CLOUD_SIGNED_OUT_MESSAGE, "unavailable");
    this.name = "CloudSignedOutError";
  }
}

/** This build has no fabplane client wired in. */
export class CloudUnavailableError extends ToolError {
  constructor() {
    super(
      "fabplane.com shopping lists and inventory are not available in this build of fabPlane.",
      "unavailable",
    );
    this.name = "CloudUnavailableError";
  }
}

/** Map a fabplane API failure onto a ToolError an agent can act on. */
export function cloudToolError(e: unknown): unknown {
  if (e instanceof ToolError || !isCloudApiError(e)) return e;
  const code =
    e.status === 400 || e.status === 413 || e.status === 415
      ? "invalid_args"
      : e.status === 404
        ? "not_found"
        : e.status === 401
          ? "unavailable"
          : e.status === 403 || e.status === 409
            ? "precondition"
            : e.status === 501 || e.status === 503
              ? "unavailable"
              : "internal";
  const message =
    e.status === 401
      ? `${CLOUD_SIGNED_OUT_MESSAGE} (fabplane.com rejected the session: ${e.message})`
      : `fabplane.com ${e.status} ${e.code}: ${e.message}`;
  return new ToolError(message, code);
}
