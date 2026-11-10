import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  TeamProjects, ContributionBoards, BoardSourceDownload,
  CartItemInput,
  CartItemPatch,
  CreateDestinationInput,
  InventoryAdjust,
  InventoryItemInput,
  BomSyncOptions,
  ProjectShareState, SharedProject, SharedProjectStatus, ShareId,
  type ProjectBomSnapshot,
} from "@fabdesk/protocol";
import {
  prepareProjectShare, prepareEditableBoard, inspectProjectBoardSources,
  CloudSignedOutError,
  CloudUnavailableError,
  isCloudApiError,
  type CloudImageUpload,
  type CloudService,
  type ProjectHandle,
} from "@fabdesk/tools";
import { extractToken } from "../auth";
import type { ProjectStore } from "../projects";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"]);

type Deps = {
  cloud: () => CloudService | undefined;
  projects: Pick<ProjectStore, "handle"> & Partial<Pick<ProjectStore, "create" | "delete" | "detail">>;
  readBom: (project: ProjectHandle) => Promise<ProjectBomSnapshot>;
  canManageSharing?: (token: string | undefined) => boolean;
  rasterizeSharePreview: (svg: string, options: { maxWidth: number }) => Promise<{ png: Uint8Array }>;
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

  const sharingBusy = new Set<string>();
  const withSharingLock = async <T>(id: string, action: () => Promise<T>): Promise<T> => {
    if (sharingBusy.has(id)) throw new RouteError(409, "share_busy", "A sharing change is already in progress. Wait for it to finish.");
    sharingBusy.add(id); try { return await action(); } finally { sharingBusy.delete(id); }
  };
  const unsupported = () => new RouteError(503, "sharing_unavailable", "Project link sharing is not available on this server yet. You can still download a review ZIP.");
  const sharingCall = async <T>(action: () => Promise<T>): Promise<T> => {
    try { return await action(); }
    catch (error) {
      if (isCloudApiError(error) && [404, 405, 501].includes(error.status)) throw unsupported();
      throw error;
    }
  };
  const shareState = (raw: unknown) => {
    const parsed = ProjectShareState.safeParse(raw);
    if (!parsed.success) throw new RouteError(502, "invalid_share_response", "The sharing server returned incomplete settings. Try again later.");
    return parsed.data;
  };
  app.get("/projects/:id/share", run(async c => {
    const handle = await project(param(c, "id")), api = cloud().client();
    if (!api.getProjectShare) throw unsupported();
    return c.json(shareState(await sharingCall(() => api.getProjectShare!(handle.id))));
  }));
  app.post("/projects/:id/share/preview", run(async c => {
    return c.json(await prepareProjectShare(await project(param(c, "id")), deps.rasterizeSharePreview));
  }));
  app.put("/projects/:id/share", run(async c => {
    if (deps.canManageSharing && !deps.canManageSharing(extractToken(c.req.raw) ?? undefined)) throw new RouteError(403, "sharing_requires_desktop", "Publish shared pages from the desktop Share dialog.");
    const handle = await project(param(c, "id")), api = cloud().client();
    if (!api.publishProjectShare) throw unsupported();
    const visibility = z.enum(["restricted", "unlisted"]).optional().parse(c.req.query("visibility"));
    const updateOnly = z.literal("true").optional().parse(c.req.query("updateOnly")) === "true";
    if (updateOnly && visibility) throw new RouteError(400, "invalid_request", "Snapshot updates cannot change project visibility.");
    return withSharingLock(handle.id, async () => {
      const snapshot = await prepareProjectShare(handle, deps.rasterizeSharePreview);
      const result = shareState(await sharingCall(() => api.publishProjectShare!(handle.id, snapshot, visibility, { updateOnly })));
      if (result.visibility === "private" || (visibility && result.visibility !== visibility)) throw new RouteError(502, "invalid_share_response", "The server did not confirm the requested publication access. Reload sharing settings before trying again.");
      return c.json(result);
    });
  }));
  app.delete("/projects/:id/share", run(async c => {
    if (deps.canManageSharing && !deps.canManageSharing(extractToken(c.req.raw) ?? undefined)) throw new RouteError(403, "sharing_requires_desktop", "Change sharing from the desktop Share dialog.");
    const handle = await project(param(c, "id")), api = cloud().client();
    if (!api.disableProjectShare) throw unsupported();
    return withSharingLock(handle.id, async () => {
      const result = shareState(await sharingCall(() => api.disableProjectShare!(handle.id)));
      if (result.visibility !== "private") throw new RouteError(502, "invalid_share_response", "The server did not confirm that sharing was disabled. Reload sharing settings.");
      return c.json(result);
    });
  }));
  app.get(
    "/shared-projects/:shareId/status",
    run(async (c) => {
      const id = ShareId.parse(param(c, "shareId")),
        api = cloud().publicClient();
      const raw = api.getSharedProjectStatus
        ? await api.getSharedProjectStatus(id)
        : api.getSharedProject
          ? await api.getSharedProject(id)
          : null;
      const parsed = SharedProjectStatus.safeParse(
        raw && typeof raw === "object"
          ? {
              shareId: (raw as any).shareId,
              publishedAt: (raw as any).publishedAt,
              revision: (raw as any).revision,
            }
          : raw,
      );
      if (!parsed.success || parsed.data.shareId !== id)
        throw new RouteError(502, "invalid_share_response", "Shared access could not be checked.");
      c.header("Cache-Control", "no-store");
      return c.json(parsed.data);
    }),
  );
  app.get("/shared-projects/:shareId", run(async c => {
    const id = ShareId.parse(param(c, "shareId")), api = cloud().publicClient();
    if (!api.getSharedProject) throw unsupported();
    const parsed = SharedProject.safeParse(await api.getSharedProject(id));
    if (!parsed.success) throw new RouteError(502, "invalid_share_response", "The shared project could not be read.");
    const result = parsed.data;
    if (result.shareId !== id) throw new RouteError(502, "invalid_share_response", "The shared project does not match this link.");
    c.header("Cache-Control", "no-store");
    return c.json(result);
  }));

  const requireDesktop = (c: Context) => {
    if (deps.canManageSharing && !deps.canManageSharing(extractToken(c.req.raw) ?? undefined))
      throw new RouteError(403,"contributions_require_desktop","Edit shared boards from the local desktop connection.");
  };
  const contributionApi = () => {
    const service=cloud(), api=service.client();
    if(!api.listSharedProjects || !api.listContributionBoards || !api.downloadBoardSource || !api.publishBoardRevision)
      throw new RouteError(503,"contributions_unavailable","Board contribution is not available in this build yet.");
    return {service,api};
  };
  const localContribution = async (id:string) => {
    const handle=await project(id), {service,api}=contributionApi();
    const receipts=handle.manifest().contributions ?? {};
    const imported=handle.manifest().contributionSource;
    const projects=TeamProjects.parse(await api.listSharedProjects!()).projects;
    const remote= imported ? projects.find(p=>p.id===imported.projectId) : projects.find(p=>p.role==="owner"&&p.localProjectId===id);
    if(!remote || !remote.publishedAt)throw new RouteError(409,"contribution_unavailable",imported ? "This shared project is unavailable to your desktop account. Check your invited account or ask the owner for access." : "Publish this project from Share first, or check your account.");
    if(imported && imported.apiOrigin!==service.apiOrigin)throw new RouteError(409,"contribution_origin_changed","This copy belongs to a different fabPlane server. Switch back before publishing.");
    const heads=ContributionBoards.parse(await api.listContributionBoards!(remote.id));
    const scope=await inspectProjectBoardSources(handle);
    const boards=heads.boards.flatMap(b=>{
      const sourceId=imported ? (b.id===imported.boardId ? "main" : null) : b.id;
      const source=scope.sources.find(s=>s.source.id===sourceId);
      if(!sourceId||!source)return [];
      const receipt=receipts[sourceId];
      if(receipt && (receipt.apiOrigin!==service.apiOrigin || receipt.projectId!==remote.id || receipt.boardId!==b.id))throw new RouteError(409,"contribution_identity_changed","This copy belongs to a different shared board or server. Download a fresh copy.");
      return [{...b,sourceId,available:source.status==="available",baseRevision:receipt?.revision??null,
        canPublish:heads.role!=="viewer" && source.status==="available" && (b.revision===null ? heads.role==="owner" : receipt?.revision===b.revision)}];
    });
    return {handle,service,api,projectId:remote.id,role:heads.role,boards};
  };
  app.get("/cloud/team-projects",run(async c=>{
    requireDesktop(c);const {api}=contributionApi();c.header("Cache-Control","no-store");
    return c.json(TeamProjects.parse(await api.listSharedProjects!()));
  }));
  app.get("/cloud/team-projects/:projectId/boards",run(async c=>{
    requireDesktop(c);const {api}=contributionApi();
    const id=z.string().uuid().parse(param(c,"projectId"));c.header("Cache-Control","no-store");
    return c.json(ContributionBoards.parse(await api.listContributionBoards!(id)));
  }));
  app.post("/cloud/team-projects/:projectId/boards/:boardId/import",run(async c=>{
    requireDesktop(c);const {api,service}=contributionApi();
    if(!deps.projects.create || !deps.projects.delete || !deps.projects.detail)throw new RouteError(503,"import_unavailable","This build cannot create an editable copy.");
    const projectId=z.string().uuid().parse(param(c,"projectId")), boardId=z.string().min(1).max(80).parse(param(c,"boardId"));
    const data=BoardSourceDownload.parse(await api.downloadBoardSource!(projectId,boardId));
    if(data.projectId!==projectId||data.boardId!==boardId)throw new RouteError(502,"invalid_contribution_response","The downloaded board does not match this project.");
    // Fresh atomic project directory: never replace the current user's board or execute downloaded code.
    const detail=await deps.projects.create(data.name.slice(0,80));
    try {
      const handle=await project(detail.id);
      await writeFile(join(handle.dir,"board.kicad_pcb"),data.files.pcb,{flag:"wx"});
      if(data.files.schematic)await writeFile(join(handle.dir,"board.kicad_sch"),data.files.schematic,{flag:"wx"});
      await writeFile(join(handle.dir,"board.kicad_pro"),JSON.stringify({meta:{filename:"board.kicad_pro",version:1}}),{flag:"wx"});
      await handle.updateManifest({contributionSource:{apiOrigin:service.apiOrigin,projectId,boardId,revision:data.revision},contributions:{main:{apiOrigin:service.apiOrigin,projectId,boardId,revision:data.revision}}});
      return c.json((await deps.projects.detail(detail.id))!,201);
    } catch(error) {await deps.projects.delete(detail.id,{purge:true});throw error;}
  }));
  app.get("/projects/:id/contributions",run(async c=>{
    requireDesktop(c);const {projectId,role,boards}=await localContribution(param(c,"id"));
    c.header("Cache-Control","no-store");return c.json({projectId,role,boards});
  }));
  app.put("/projects/:id/contributions/:sourceId",run(async c=>{
    requireDesktop(c);const id=param(c,"id"), sourceId=param(c,"sourceId");
    return withSharingLock(id,async()=>{
      const current=await localContribution(id), row=current.boards.find(b=>b.sourceId===sourceId);
      if(!row||current.role==="viewer")throw new RouteError(403,"contribution_forbidden","Contributor access is required.");
      if(!row.available)throw new RouteError(409,"source_unavailable","This board’s native source is unavailable. Restore its project-owned KiCad PCB before publishing.");
      if(!row.canPublish)throw new RouteError(409,"contribution_conflict","A newer revision is available. Download it into a separate copy; your local edits will stay here.");
      const files=await prepareEditableBoard(current.handle,sourceId);
      const snapshot=await prepareProjectShare(current.handle,deps.rasterizeSharePreview);
      const board=snapshot.boards.find(b=>b.id===sourceId);
      if(!board)throw new RouteError(409,"source_changed","This board source is no longer available.");
      await files.verify();
      const result=z.object({revision:z.string().uuid()}).parse(await current.api.publishBoardRevision!(current.projectId,row.id,{expectedRevision:row.baseRevision,files:files.files,board:{...board,id:row.id,name:row.name}}));
      await current.handle.updateManifest({contributions:{...current.handle.manifest().contributions,[sourceId]:{apiOrigin:current.service.apiOrigin,projectId:current.projectId,boardId:row.id,revision:result.revision}}});
      return c.json(result);
    });
  }));

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
    run(async (c) => {
      const raw = await c.req.text(); let body: unknown;
      try { body = raw ? JSON.parse(raw) : {}; } catch { throw new RouteError(400, "invalid_request", "Expected JSON BOM sync options."); }
      const options = BomSyncOptions.parse(body), handle = await project(param(c, "id"));
      const service = cloud(); service.client();
      return c.json(await service.syncBom(handle, await deps.readBom(handle), options));
    }),
  );

  return app;
}
