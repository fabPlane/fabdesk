/**
 * fabplane.com shopping lists and inventory, proxied through the daemon so the UI never holds the
 * fabplane token: `/cloud/*` and `/projects/:id/shopping-list*`.
 *
 * Signed out → 401 `{ error: "cloud_signed_out" }`; no client in this build → 503
 * `{ error: "cloud_unavailable" }`; fabplane API errors keep their status and code.
 */
import { Hono, type Context } from "hono";
import { z } from "zod/v4";
import {
  CartItemInput,
  CartItemPatch,
  CreateDestinationInput,
  InventoryAdjust,
  InventoryItemInput,
} from "@fabdesk/protocol";
import {
  CloudSignedOutError,
  CloudUnavailableError,
  isCloudApiError,
  type CloudImageUpload,
  type CloudService,
  type ProjectHandle,
} from "@fabdesk/tools";
import type { ProjectStore } from "../projects";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"]);

type Deps = {
  cloud: () => CloudService | undefined;
  projects: Pick<ProjectStore, "handle">;
};

const param = (c: Context, name: string): string => c.req.param(name) ?? "";

class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function cloudRoutes<E extends object>(deps: Deps): Hono<{ Variables: E }> {
  const app = new Hono<{ Variables: E }>();

  const cloud = (): CloudService => {
    const c = deps.cloud();
    if (!c) throw new CloudUnavailableError();
    return c;
  };
  const project = async (id: string): Promise<ProjectHandle> => {
    const h = await deps.projects.handle(id);
    if (!h) throw new RouteError(404, "not_found", "project not found");
    return h;
  };

  /** Runs a handler, mapping cloud failures to JSON errors; anything else goes to app.onError. */
  const run =
    (fn: (c: Context<{ Variables: E }>) => Promise<Response>) =>
    async (c: Context<{ Variables: E }>): Promise<Response> => {
      try {
        return await fn(c);
      } catch (e) {
        if (e instanceof CloudSignedOutError)
          return c.json({ error: "cloud_signed_out", message: e.message }, 401);
        if (e instanceof CloudUnavailableError)
          return c.json({ error: "cloud_unavailable", message: e.message }, 503);
        if (e instanceof RouteError)
          return c.json({ error: e.code, message: e.message }, e.status as 404);
        if (e instanceof z.ZodError)
          return c.json({ error: "invalid_request", message: z.prettifyError(e) }, 400);
        if (isCloudApiError(e)) {
          // fabplane rejecting the stored token means the user has to sign in again.
          if (e.status === 401)
            return c.json({ error: "cloud_signed_out", message: e.message }, 401);
          const status = e.status >= 400 && e.status <= 599 ? e.status : 502;
          return c.json({ error: e.code, message: e.message }, status as 400);
        }
        throw e;
      }
    };

  app.get(
    "/cloud/status",
    run(async (c) => {
      const svc = deps.cloud();
      if (!svc) throw new CloudUnavailableError();
      return c.json(await svc.status());
    }),
  );

  app.get(
    "/cloud/destinations",
    run(async (c) => c.json({ destinations: await cloud().destinations() })),
  );
  app.post(
    "/cloud/destinations",
    run(async (c) => {
      const body = CreateDestinationInput.parse(await c.req.json());
      return c.json({ destination: await cloud().addDestination(body) }, 201);
    }),
  );

  app.get(
    "/cloud/inventory",
    run(async (c) => {
      const q = c.req.query();
      const limit = q["limit"] ? Number(q["limit"]) : undefined;
      return c.json(
        await cloud().searchInventory({
          ...(q["q"] ? { q: q["q"] } : {}),
          ...(q["category"] ? { category: q["category"] } : {}),
          ...(q["location"] ? { location: q["location"] } : {}),
          ...(q["tag"] ? { tag: q["tag"] } : {}),
          ...(q["cursor"] ? { cursor: q["cursor"] } : {}),
          ...(limit && Number.isFinite(limit) ? { limit: Math.min(200, Math.max(1, limit)) } : {}),
        }),
      );
    }),
  );
  app.post(
    "/cloud/inventory",
    run(async (c) => {
      const ct = c.req.header("content-type") ?? "";
      let input: unknown;
      const images: CloudImageUpload[] = [];
      if (ct.startsWith("multipart/form-data")) {
        const form = await c.req.formData();
        const raw = form.get("item");
        if (typeof raw !== "string")
          throw new RouteError(400, "invalid_request", "multipart field `item` (JSON) required");
        input = JSON.parse(raw);
        for (const f of form.getAll("image")) {
          if (!(f instanceof File)) continue;
          if (!IMAGE_TYPES.has(f.type))
            throw new RouteError(415, "unsupported_media_type", `unsupported image type ${f.type || "(none)"}`);
          if (f.size > MAX_IMAGE_BYTES)
            throw new RouteError(413, "payload_too_large", "images are limited to 10 MiB");
          images.push({ data: new Uint8Array(await f.arrayBuffer()), contentType: f.type, filename: f.name || "image" });
        }
      } else {
        input = await c.req.json();
      }
      const body = InventoryItemInput.parse(input);
      return c.json({ item: await cloud().addInventoryItem(body, images) }, 201);
    }),
  );
  app.post(
    "/cloud/inventory/:itemId/adjust",
    run(async (c) => {
      const body = InventoryAdjust.parse(await c.req.json());
      return c.json({
        item: await cloud().adjustInventory(param(c, "itemId"), body.delta, body.reason),
      });
    }),
  );

  app.get(
    "/projects/:id/shopping-list",
    run(async (c) => c.json(await cloud().shoppingList(await project(param(c, "id"))))),
  );
  app.post(
    "/projects/:id/shopping-list",
    run(async (c) => {
      const res = await cloud().ensureShoppingList(await project(param(c, "id")));
      return c.json(res, res.created ? 201 : 200);
    }),
  );
  app.post(
    "/projects/:id/shopping-list/items",
    run(async (c) => {
      const body = z
        .object({ items: z.array(CartItemInput).min(1).max(500) })
        .parse(await c.req.json());
      return c.json(await cloud().addItems(await project(param(c, "id")), body.items), 201);
    }),
  );
  app.patch(
    "/projects/:id/shopping-list/items/:itemId",
    run(async (c) => {
      const patch = CartItemPatch.parse(await c.req.json());
      const item = await cloud().updateItem(
        await project(param(c, "id")),
        param(c, "itemId"),
        patch,
      );
      return c.json({ item });
    }),
  );
  app.delete(
    "/projects/:id/shopping-list/items/:itemId",
    run(async (c) => {
      await cloud().removeItem(await project(param(c, "id")), param(c, "itemId"));
      return c.json({ ok: true });
    }),
  );
  app.post(
    "/projects/:id/shopping-list/sync-bom",
    run(async (c) => c.json(await cloud().syncBom(await project(param(c, "id"))))),
  );

  return app;
}
