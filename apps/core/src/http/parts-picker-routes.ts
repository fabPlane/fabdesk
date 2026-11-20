/**
 * Local daemon routes for the in-KiCad parts picker plugin.
 *
 * The plugin talks only to this daemon (daemon.json). Team/org hits are fetched
 * from fabplane.com with the stored `fpd_` token; user and KiCad-standard hits
 * are searched locally.
 */
import type { Context, Hono } from "hono";
import { z } from "zod/v4";
import {
  buildSchematicClipboard,
  clipboardLooksPasteable,
  makePartFromDatasheet,
} from "@fabdesk/kicad";
import {
  CloudSignedOutError,
  CloudUnavailableError,
  isCloudApiError,
  type CloudService,
} from "@fabdesk/tools";
import { KicadLibraryCatalog, type CatalogPickerHit } from "../kicad-library-catalog";
import { searchUserLibraries } from "../kicad-user-libraries";

export type PickerSource = "user" | "team" | "kicad";

export type PickerHit = {
  id: string;
  source: PickerSource;
  sourceLabel: string;
  symbol: string;
  footprint: string;
  value: string;
  pasteable: boolean;
  mpn?: string;
  manufacturer?: string;
  description?: string;
};

export type TeamCadPartHit = {
  id: string;
  library: string;
  name: string;
  value: string;
  footprint: string;
  symbolLibId: string;
  reference: string;
  description: string;
  pasteable: boolean;
  mpn?: string;
  manufacturer?: string;
  datasheetUrl?: string;
  paste?: string;
};

export type TeamCadPartsClient = {
  search(q: string, limit: number): Promise<{ parts: TeamCadPartHit[]; makeThisPart: boolean }>;
  get(id: string): Promise<{ part: TeamCadPartHit & { paste: string } }>;
  make(body: {
    mpn?: string;
    datasheetUrl?: string;
    value?: string;
    manufacturer?: string;
  }): Promise<{ part: TeamCadPartHit & { paste: string }; created: boolean }>;
};

export type PartsPickerRouteDeps = {
  cloud: () => CloudService | undefined;
  catalog: KicadLibraryCatalog;
  searchUser?: (q: string, limit: number) => Promise<CatalogPickerHit[]>;
  team?: TeamCadPartsClient;
};

const SOURCE_LABEL: Record<PickerSource, string> = {
  user: "My libraries",
  team: "Team library",
  kicad: "KiCad",
};

const searchQuery = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const pasteBody = z
  .object({
    id: z.string().min(1).max(300).optional(),
    source: z.enum(["user", "team", "kicad"]).optional(),
    symbol: z.string().min(1).max(200).optional(),
    footprint: z.string().max(300).optional(),
    value: z.string().max(200).optional(),
    mpn: z.string().max(120).optional(),
    manufacturer: z.string().max(120).optional(),
    reference: z.string().max(16).optional(),
  })
  .strict();

const makeBody = z
  .object({
    mpn: z.string().trim().min(1).max(120).optional(),
    datasheetUrl: z.string().trim().url().max(2000).optional(),
    manufacturer: z.string().trim().min(1).max(120).optional(),
    value: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.mpn || value.datasheetUrl), {
    message: "mpn or datasheetUrl is required",
  });

function present<T extends Record<string, unknown>>(row: T): T {
  return row;
}

function fromCatalog(source: PickerSource, hit: CatalogPickerHit): PickerHit {
  return present({
    id: `${source}:${hit.libId}`,
    source,
    sourceLabel: SOURCE_LABEL[source],
    symbol: hit.libId,
    footprint: hit.footprint,
    value: hit.value,
    pasteable: true,
    ...(hit.mpn ? { mpn: hit.mpn } : {}),
    ...(hit.manufacturer ? { manufacturer: hit.manufacturer } : {}),
    ...(hit.description ? { description: hit.description } : {}),
  });
}

function fromTeam(hit: TeamCadPartHit): PickerHit {
  const source: PickerSource = hit.library === "user" ? "user" : "team";
  return present({
    id: hit.id,
    source,
    sourceLabel: source === "user" ? SOURCE_LABEL.user : SOURCE_LABEL.team,
    symbol: hit.symbolLibId,
    footprint: hit.footprint,
    value: hit.value || hit.name,
    pasteable: hit.pasteable || Boolean(hit.paste && clipboardLooksPasteable(hit.paste)),
    ...(hit.mpn ? { mpn: hit.mpn } : {}),
    ...(hit.manufacturer ? { manufacturer: hit.manufacturer } : {}),
    ...(hit.description ? { description: hit.description } : {}),
  });
}

class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function teamCadPartsClient(cloud: CloudService): TeamCadPartsClient {
  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    if (!cloud.signedIn()) throw new CloudSignedOutError();
    const token = cloud.token();
    const orgId = await cloud.activeOrgId();
    const url = `${cloud.apiOrigin}/v1/private/orgs/${orgId}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token ?? ""}`,
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(
        typeof (body as { message?: unknown }).message === "string"
          ? (body as { message: string }).message
          : res.statusText,
      ) as Error & { status: number; code: string };
      err.status = res.status;
      err.code =
        typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : "fabplane_error";
      throw err;
    }
    return body;
  };
  return {
    async search(q, limit) {
      const qs = new URLSearchParams();
      if (q) qs.set("q", q);
      qs.set("limit", String(limit));
      return request(`/cad-parts?${qs}`) as Promise<{ parts: TeamCadPartHit[]; makeThisPart: boolean }>;
    },
    async get(id) {
      return request(`/cad-parts/${encodeURIComponent(id)}`) as Promise<{
        part: TeamCadPartHit & { paste: string };
      }>;
    },
    async make(body) {
      return request("/cad-parts/make", {
        method: "POST",
        body: JSON.stringify(body),
      }) as Promise<{ part: TeamCadPartHit & { paste: string }; created: boolean }>;
    },
  };
}

function requireCloud(cloud: CloudService | undefined): CloudService {
  if (!cloud) throw new CloudUnavailableError();
  if (!cloud.signedIn()) throw new CloudSignedOutError();
  return cloud;
}

export function partsPickerRoutes<E extends { Variables?: object }>(
  app: Hono<E>,
  deps: PartsPickerRouteDeps,
): void {
  const run =
    (fn: (c: Context) => Promise<Response>) =>
    async (c: Context): Promise<Response> => {
      try {
        return await fn(c);
      } catch (e) {
        if (e instanceof CloudSignedOutError)
          return c.json({ error: "cloud_signed_out", message: e.message }, 401);
        if (e instanceof CloudUnavailableError)
          return c.json({ error: "cloud_unavailable", message: e.message }, 503);
        if (e instanceof RouteError)
          return c.json({ error: e.code, message: e.message }, e.status as 400);
        if (e instanceof z.ZodError)
          return c.json({ error: "invalid_request", message: z.prettifyError(e) }, 400);
        if (isCloudApiError(e)) {
          if (e.status === 401) return c.json({ error: "cloud_signed_out", message: e.message }, 401);
          const status = e.status >= 400 && e.status <= 599 ? e.status : 502;
          return c.json({ error: e.code, message: e.message }, status as 400);
        }
        throw e;
      }
    };

  const teamOf = async (): Promise<TeamCadPartsClient | undefined> => {
    if (deps.team) return deps.team;
    const cloud = deps.cloud();
    if (!cloud?.signedIn()) return undefined;
    return teamCadPartsClient(cloud);
  };

  app.get(
    "/parts-picker",
    run(async (c) => {
      const cloud = requireCloud(deps.cloud());
      const status = await cloud.status();
      const org = status.orgs.find((row) => row.id === status.activeOrgId);
      return c.json({
        signedIn: true,
        orgId: status.activeOrgId,
        orgName: org?.name ?? org?.slug ?? "",
        makeThisPart: true,
      });
    }),
  );

  app.get(
    "/parts-picker/search",
    run(async (c) => {
      requireCloud(deps.cloud());
      const query = searchQuery.parse({
        q: c.req.query("q"),
        ...(c.req.query("limit") ? { limit: c.req.query("limit") } : {}),
      });
      const q = query.q?.trim() ?? "";
      const limit = query.limit ?? 40;
      if (!q) {
        return c.json({
          hits: [],
          makeThisPart: false,
          message: "Type a part number, value, or footprint.",
        });
      }
      const per = Math.max(8, Math.ceil(limit / 2));
      const searchUser = deps.searchUser ?? ((qq: string, n: number) => searchUserLibraries(qq, n));
      const [kicad, user, teamResult] = await Promise.all([
        deps.catalog.searchPicker(q, per),
        searchUser(q, per).catch(() => [] as CatalogPickerHit[]),
        teamOf()
          .then((team) => team?.search(q, per))
          .catch((error) => {
            if (isCloudApiError(error) && (error.status === 404 || error.status === 501))
              return { parts: [] as TeamCadPartHit[], makeThisPart: true };
            throw error;
          }),
      ]);
      const hits: PickerHit[] = [];
      const seen = new Set<string>();
      const push = (hit: PickerHit) => {
        const key = `${hit.source}:${hit.mpn ?? hit.symbol}:${hit.footprint}`;
        if (seen.has(key)) return;
        seen.add(key);
        hits.push(hit);
      };
      for (const row of teamResult?.parts ?? []) push(fromTeam(row));
      for (const row of user) push(fromCatalog("user", row));
      for (const row of kicad) push(fromCatalog("kicad", row));
      const sliced = hits.slice(0, limit);
      const makeThisPart = sliced.length === 0;
      return c.json({
        hits: sliced,
        makeThisPart,
        message: makeThisPart
          ? "No matches in my libraries, the team library, or KiCad."
          : `${sliced.length} match${sliced.length === 1 ? "" : "es"}. Pick one, then paste into the schematic.`,
      });
    }),
  );

  app.post(
    "/parts-picker/paste",
    run(async (c) => {
      requireCloud(deps.cloud());
      const body = pasteBody.parse(await c.req.json());
      if (body.source === "team" || (body.id && !body.id.startsWith("user:") && !body.id.startsWith("kicad:"))) {
        const team = await teamOf();
        if (!team || !body.id) throw new RouteError(400, "invalid_request", "team part id is required");
        const fetched = await team.get(body.id);
        if (!clipboardLooksPasteable(fetched.part.paste))
          throw new RouteError(502, "invalid_paste", "team library returned a snippet that is not pasteable");
        return c.json({ paste: fetched.part.paste, pasteable: true, part: fromTeam(fetched.part) });
      }
      const symbol = body.symbol ?? body.id?.replace(/^(user|kicad):/, "");
      if (!symbol) throw new RouteError(400, "invalid_request", "symbol is required");
      const paste = buildSchematicClipboard({
        libId: symbol,
        reference: body.reference || "U",
        value: body.value || symbol.split(":").at(-1) || symbol,
        footprint: body.footprint ?? "",
        ...(body.mpn ? { mpn: body.mpn } : {}),
        ...(body.manufacturer ? { manufacturer: body.manufacturer } : {}),
      });
      return c.json({
        paste,
        pasteable: clipboardLooksPasteable(paste),
        part: {
          id: body.id ?? symbol,
          source: body.source ?? "kicad",
          sourceLabel: SOURCE_LABEL[body.source ?? "kicad"],
          symbol,
          footprint: body.footprint ?? "",
          value: body.value || symbol,
          pasteable: true,
          ...(body.mpn ? { mpn: body.mpn } : {}),
          ...(body.manufacturer ? { manufacturer: body.manufacturer } : {}),
        } satisfies PickerHit,
      });
    }),
  );

  app.post(
    "/parts-picker/make",
    run(async (c) => {
      requireCloud(deps.cloud());
      const body = makeBody.parse(await c.req.json());
      const local = makePartFromDatasheet({
        ...(body.mpn ? { mpn: body.mpn } : {}),
        ...(body.datasheetUrl ? { datasheetUrl: body.datasheetUrl } : {}),
        ...(body.manufacturer ? { manufacturer: body.manufacturer } : {}),
        ...(body.value ? { value: body.value } : {}),
      });
      const team = await teamOf();
      if (team) {
        try {
          const made = await team.make(body);
          if (clipboardLooksPasteable(made.part.paste))
            return c.json(
              { paste: made.part.paste, created: made.created, part: fromTeam(made.part) },
              made.created ? 201 : 200,
            );
        } catch (error) {
          if (!(isCloudApiError(error) && (error.status === 404 || error.status === 501))) throw error;
        }
      }
      return c.json(
        {
          paste: local.paste,
          created: true,
          part: {
            id: `local:${local.symbolLibId}`,
            source: "team" as const,
            sourceLabel: SOURCE_LABEL.team,
            symbol: local.symbolLibId,
            footprint: local.footprint,
            value: local.value,
            pasteable: true,
            ...(local.mpn ? { mpn: local.mpn } : {}),
            ...(local.manufacturer ? { manufacturer: local.manufacturer } : {}),
            ...(local.description ? { description: local.description } : {}),
          } satisfies PickerHit,
        },
        201,
      );
    }),
  );
}
