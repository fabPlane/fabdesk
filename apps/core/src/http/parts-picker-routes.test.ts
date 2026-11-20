import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudService, type CloudApi } from "@fabdesk/tools";
import { clipboardLooksPasteable } from "@fabdesk/kicad";
import { KicadLibraryCatalog } from "../kicad-library-catalog";
import {
  partsPickerRoutes,
  type PartsPickerRouteDeps,
  type TeamCadPartHit,
  type TeamCadPartsClient,
} from "./parts-picker-routes";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

const org = {
  id: "org-1",
  slug: "lab",
  name: "Lab",
  personal: false,
  role: "owner" as const,
  memberCount: 1,
  domainJoin: null,
  createdAt: "t",
};

function cloudOf(token: string | null): CloudService {
  return new CloudService({
    apiOrigin: "https://api.fabplane.com",
    token: () => token,
    orgSetting: () => "org-1",
    api: () =>
      ({
        listOrgs: async () => ({ orgs: [org] }),
      }) as CloudApi,
  });
}

const emptyTeam: TeamCadPartsClient = {
  search: async () => ({ parts: [], makeThisPart: true }),
  get: async () => {
    const err = new Error("not found") as Error & { status: number; code: string };
    err.status = 404;
    err.code = "not_found";
    throw err;
  },
  make: async () => {
    const err = new Error("not implemented") as Error & { status: number; code: string };
    err.status = 501;
    err.code = "not_implemented";
    throw err;
  },
};

async function deviceCatalog(): Promise<KicadLibraryCatalog> {
  const root = await mkdtemp(join(tmpdir(), "fabdesk-picker-routes-"));
  roots.push(root);
  const symbols = join(root, "symbols");
  await mkdir(symbols, { recursive: true });
  await writeFile(
    join(symbols, "Device.kicad_sym"),
    `(kicad_symbol_lib (version 20231120)
      (symbol "R"
        (property "Value" "R")
        (property "Footprint" "Resistor_SMD:R_0402_1005Metric")
        (property "ki_keywords" "R res resistor")
        (property "ki_description" "Resistor")
        (pin passive line (at 0 0 0) (length 2.54) (name "~") (number "1"))
        (pin passive line (at 2.54 0 180) (length 2.54) (name "~") (number "2"))))`,
  );
  return new KicadLibraryCatalog({ symbols });
}

function appOf(deps: Partial<PartsPickerRouteDeps> & { token?: string | null; cloudMissing?: boolean } = {}) {
  const app = new Hono();
  const token = deps.token === undefined ? "tok" : deps.token;
  partsPickerRoutes(app, {
    cloud: () => (deps.cloudMissing ? undefined : cloudOf(token)),
    catalog: deps.catalog ?? new KicadLibraryCatalog({}),
    searchUser: deps.searchUser ?? (async () => []),
    team: deps.team ?? emptyTeam,
  });
  return app;
}

const yageo: TeamCadPartHit = {
  id: "cad_rc0402",
  library: "org",
  name: "RC0402FR-0710KL",
  value: "10k",
  footprint: "Resistor_SMD:R_0402_1005Metric",
  symbolLibId: "Device:R",
  reference: "R",
  description: "10k 0402",
  pasteable: true,
  mpn: "RC0402FR-0710KL",
  manufacturer: "Yageo",
  paste: `(kicad_sch (lib_symbols (symbol "fabplane:RC0402FR-0710KL")) (symbol (lib_id "fabplane:RC0402FR-0710KL") (property "Footprint" "Resistor_SMD:R_0402_1005Metric")))`,
};

describe("parts picker routes", () => {
  test("signed-out callers get 401", async () => {
    const app = appOf({ token: null });
    const res = await app.request("/parts-picker");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "cloud_signed_out" });
  });

  test("signed-in status names the active org", async () => {
    const app = appOf();
    const res = await app.request("/parts-picker");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      signedIn: true,
      orgId: "org-1",
      orgName: "Lab",
      makeThisPart: true,
    });
  });

  test("empty query asks the user to type something", async () => {
    const app = appOf();
    const res = await app.request("/parts-picker/search?q=");
    expect(await res.json()).toMatchObject({
      hits: [],
      makeThisPart: false,
      message: "Type a part number, value, or footprint.",
    });
  });

  test("search merges team, user, and KiCad hits and offers Make this part when empty", async () => {
    const catalog = await deviceCatalog();
    const app = appOf({
      catalog,
      searchUser: async (q) =>
        /rc0402/i.test(q)
          ? [
              {
                libId: "Mine:R",
                footprint: "Resistor_SMD:R_0402_1005Metric",
                value: "R",
                pinNumbers: ["1", "2"],
              },
            ]
          : [],
      team: {
        ...emptyTeam,
        search: async (q) =>
          /rc0402/i.test(q)
            ? { parts: [yageo], makeThisPart: false }
            : { parts: [], makeThisPart: true },
      },
    });
    const found = await app.request("/parts-picker/search?q=RC0402");
    const body = (await found.json()) as {
      hits: Array<{ source: string; sourceLabel: string; mpn?: string }>;
      makeThisPart: boolean;
      message: string;
    };
    expect(body.makeThisPart).toBe(false);
    expect(body.hits.map((hit) => hit.source)).toEqual(["team", "user", "kicad"]);
    expect(body.hits[0]).toMatchObject({
      sourceLabel: "Team library",
      mpn: "RC0402FR-0710KL",
      symbol: "Device:R",
    });
    expect(body.message).toMatch(/3 matches/);

    const empty = await app.request("/parts-picker/search?q=TPS7A02");
    expect(await empty.json()).toMatchObject({
      hits: [],
      makeThisPart: true,
      message: "No matches in my libraries, the team library, or KiCad.",
    });
  });

  test("paste builds a self-contained schematic clipboard snippet", async () => {
    const app = appOf();
    const res = await app.request("/parts-picker/paste", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "kicad",
        symbol: "Device:R",
        footprint: "Resistor_SMD:R_0402_1005Metric",
        value: "10k",
        mpn: "RC0402FR-0710KL",
        manufacturer: "Yageo",
        reference: "R",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { paste: string; pasteable: boolean };
    expect(body.pasteable).toBe(true);
    expect(clipboardLooksPasteable(body.paste)).toBe(true);
    expect(body.paste).toContain('(lib_id "Device:R")');
    expect(body.paste).toContain('(property "MPN" "RC0402FR-0710KL"');
    expect(body.paste).toContain('(property "Manufacturer" "Yageo"');
    expect(body.paste).toContain('(property "Footprint" "Resistor_SMD:R_0402_1005Metric"');
  });

  test("make falls back to the local Device template when the team API is absent", async () => {
    const app = appOf();
    const res = await app.request("/parts-picker/make", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mpn: "TPS7A02" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { paste: string; created: boolean; part: { symbol: string } };
    expect(body.created).toBe(true);
    expect(clipboardLooksPasteable(body.paste)).toBe(true);
    expect(body.part.symbol).toBe("fabplane:TPS7A02");
    expect(body.paste).toContain('(property "MPN" "TPS7A02"');
  });

  test("make requires an MPN or datasheet URL", async () => {
    const app = appOf();
    const res = await app.request("/parts-picker/make", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
