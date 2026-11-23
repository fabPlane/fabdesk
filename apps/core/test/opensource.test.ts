import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db";
import { catalogPreviewUrl, isGitHubAssetHost } from "@fabdesk/protocol";
import { allowedCloneUrl, fetchOpenCatalog, findCatalogProject } from "../src/opensource/catalog";
import type { DrcReport, DrcViolation, ErcReport } from "@fabdesk/kicad";
import { savedHierarchyRevision } from "@fabdesk/tools";
import {
  assessOrderReadiness,
  loadOrderCheckEvidence,
  startOrderSession,
  type OrderCheckEvidence,
} from "../src/opensource/order";
import {
  createPreviewCache,
  fallbackPreviewSvg,
  isRateLimitedPreviewHost,
  isTrustedPreviewUrl,
  previewCandidateUrls,
  resolveCatalogPreview,
  sniffImageType,
} from "../src/opensource/preview";
import { OPEN_CATALOG_SEED } from "../src/opensource/seed";
import { ProjectStore } from "../src/projects";

describe("open catalog", () => {
  test("seed has twenty unique PCB projects", () => {
    expect(OPEN_CATALOG_SEED).toHaveLength(20);
    expect(new Set(OPEN_CATALOG_SEED.map((p) => p.id)).size).toBe(20);
  });

  test("fetchOpenCatalog falls back to the seed when the API is down", async () => {
    const index = await fetchOpenCatalog("http://127.0.0.1:9", "lvds", async () => {
      throw new Error("offline");
    });
    expect(index.source).toBe("seed");
    expect(index.projects.map((p) => p.id)).toEqual(["tensorfleet/koyomi-lvds-hat"]);
  });

  test("fetchOpenCatalog prefers a live API payload", async () => {
    const index = await fetchOpenCatalog("https://api.fabplane.com", undefined, async () =>
      Response.json({
        generatedAt: "2026-09-03T00:00:00.000Z",
        source: "r2-list",
        projects: [OPEN_CATALOG_SEED[0]],
      }),
    );
    expect(index.source).toBe("r2-list");
    expect(index.projects).toHaveLength(1);
    expect(findCatalogProject(index, "tensorfleet/koyomi-lvds-hat")?.name).toBe("Koyomi LVDS HAT");
  });

  test("seed preview and hero URLs are hosted on the images CDN, not GitHub or the website", () => {
    expect(OPEN_CATALOG_SEED).toHaveLength(20);
    for (const project of OPEN_CATALOG_SEED) {
      expect(isGitHubAssetHost(project.previewUrl)).toBe(false);
      expect(isRateLimitedPreviewHost(project.previewUrl)).toBe(false);
      expect(project.previewUrl).toBe(catalogPreviewUrl(project.ownerSlug, project.slug));
      expect(project.previewUrl.startsWith("https://images.fabplane.com/artifacts/open-catalog/")).toBe(true);
      expect(project.previewUrl.includes("://fabplane.com/")).toBe(false);
      expect(project.heroUrl).toBe(project.previewUrl);
      expect(project.photoUrl).toBe(`https://images.fabplane.com/artifacts/open-catalog/${project.ownerSlug}/${project.slug}/photo.webp`);
    }
  });

  test("allowedCloneUrl only accepts https GitHub git URLs", () => {
    expect(allowedCloneUrl("https://github.com/TensorFleet/koyomi-lvds-hat.git")).toBe(true);
    expect(allowedCloneUrl("https://evil.example/x.git")).toBe(false);
    expect(allowedCloneUrl("git@github.com:TensorFleet/koyomi-lvds-hat.git")).toBe(false);
  });
});

describe("catalog preview proxy", () => {
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) =>
    c.charCodeAt(0),
  );

  test("sniffImageType accepts PNG and rejects GitHub's Too many body", () => {
    expect(sniffImageType(png)).toBe("image/png");
    expect(sniffImageType(new TextEncoder().encode("Too many"))).toBeNull();
  });

  test("previewCandidateUrls drops GitHub hosts and keeps hosted 3D first", () => {
    const project = OPEN_CATALOG_SEED.find((p) => p.id === "im-tomu/fomu-hardware")!;
    expect(previewCandidateUrls(project)[0]).toBe("https://images.fabplane.com/artifacts/open-catalog/im-tomu/fomu-hardware/preview.webp");
    const og = {
      ...project,
      previewUrl: "https://opengraph.github.com/repo/im-tomu/fomu-hardware",
      photoUrl: "https://raw.githubusercontent.com/im-tomu/fomu-hardware/master/fomu.png",
      heroUrl: "https://images.fabplane.com/artifacts/open-catalog/im-tomu/fomu-hardware/preview.webp",
    };
    expect(previewCandidateUrls(og)).toEqual([
      "https://images.fabplane.com/artifacts/open-catalog/im-tomu/fomu-hardware/preview.webp",
      "https://images.fabplane.com/artifacts/open-catalog/im-tomu/fomu-hardware/photo.webp",
    ]);
  });

  test("previewCandidateUrls derives hosted CDN paths when the API still returns GitHub URLs", () => {
    const project = OPEN_CATALOG_SEED.find((p) => p.id === "im-tomu/fomu-hardware")!;
    const githubOnly = {
      ...project,
      previewUrl: "https://opengraph.github.com/repo/im-tomu/fomu-hardware",
      heroUrl: "https://raw.githubusercontent.com/im-tomu/fomu-hardware/master/fomu.png",
      photoUrl: "https://github.com/im-tomu/fomu-hardware/raw/master/fomu.png",
    };
    expect(previewCandidateUrls(githubOnly)).toEqual([
      catalogPreviewUrl("im-tomu", "fomu-hardware"),
      `https://images.fabplane.com/artifacts/open-catalog/im-tomu/fomu-hardware/photo.webp`,
    ]);
  });

  test("isTrustedPreviewUrl allows the images CDN and rejects private destinations", () => {
    expect(isTrustedPreviewUrl("https://images.fabplane.com/artifacts/open-catalog/im-tomu/fomu-hardware/preview.webp")).toBe(true);
    expect(isTrustedPreviewUrl("http://images.fabplane.com/artifacts/open-catalog/im-tomu/fomu-hardware/preview.webp")).toBe(false);
    expect(isTrustedPreviewUrl("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(isTrustedPreviewUrl("https://127.0.0.1/preview.webp")).toBe(false);
    expect(isTrustedPreviewUrl("https://evil.example/preview.webp")).toBe(false);
    expect(isTrustedPreviewUrl("https://github.com/im-tomu/fomu-hardware/raw/master/fomu.png")).toBe(false);
    expect(isTrustedPreviewUrl("https://opengraph.github.com/repo/im-tomu/fomu-hardware")).toBe(false);
    expect(isTrustedPreviewUrl("https://raw.githubusercontent.com/im-tomu/fomu-hardware/master/fomu.png")).toBe(false);
    expect(isTrustedPreviewUrl("https://fabplane.com/open-catalog/im-tomu/fomu-hardware/preview.webp")).toBe(true);
    expect(isTrustedPreviewUrl("https://www.fabplane.com/open-catalog/im-tomu/fomu-hardware/preview.webp")).toBe(true);
  });

  test("resolveCatalogPreview serves shipped catalog assets without fetching", async () => {
    const prev = process.env["CATALOG_ASSET_DIR"];
    delete process.env["CATALOG_ASSET_DIR"];
    try {
      const image = await resolveCatalogPreview(OPEN_CATALOG_SEED[0]!, {
        cache: createPreviewCache(),
        fetchImpl: async () => {
          throw new Error("should not fetch GitHub or the CDN");
        },
      });
      expect(image.contentType).toBe("image/webp");
      expect(image.body.length).toBeGreaterThan(64);
    } finally {
      if (prev !== undefined) process.env["CATALOG_ASSET_DIR"] = prev;
    }
  });

  test("hero role serves preview.webp, not the rehosted GitHub photo.webp", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-hero-"));
    const dest = join(dir, "im-tomu", "fomu-hardware");
    const previewPng = png;
    const photoPng = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8BQz0AEYBxVAAAwKwI/aR9BXwAAAABJRU5ErkJggg=="),
      (c) => c.charCodeAt(0),
    );
    await Bun.write(join(dest, "preview.webp"), previewPng);
    await Bun.write(join(dest, "photo.webp"), photoPng);
    const prev = process.env["CATALOG_ASSET_DIR"];
    process.env["CATALOG_ASSET_DIR"] = dir;
    try {
      const project = OPEN_CATALOG_SEED.find((p) => p.id === "im-tomu/fomu-hardware")!;
      const hero = await resolveCatalogPreview(project, {
        cache: createPreviewCache(),
        role: "hero",
        fetchImpl: async () => {
          throw new Error("should not fetch");
        },
      });
      expect(hero.body.length).toBe(previewPng.length);
      expect(hero.body.length).not.toBe(photoPng.length);
    } finally {
      if (prev === undefined) delete process.env["CATALOG_ASSET_DIR"];
      else process.env["CATALOG_ASSET_DIR"] = prev;
    }
  });

  test("resolveCatalogPreview reads CATALOG_ASSET_DIR before fetching", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-assets-"));
    const dest = join(dir, "tensorfleet", "koyomi-lvds-hat");
    await Bun.write(join(dest, "preview.webp"), png);
    const prev = process.env["CATALOG_ASSET_DIR"];
    process.env["CATALOG_ASSET_DIR"] = dir;
    try {
      const image = await resolveCatalogPreview(OPEN_CATALOG_SEED[0]!, {
        cache: createPreviewCache(),
        fetchImpl: async () => {
          throw new Error("should not fetch");
        },
      });
      expect(image.contentType).toBe("image/png");
      expect(image.body[0]).toBe(0x89);
    } finally {
      if (prev === undefined) delete process.env["CATALOG_ASSET_DIR"];
      else process.env["CATALOG_ASSET_DIR"] = prev;
    }
  });

  test("previewCandidateUrls puts the hero image first when role is hero", () => {
    const project = {
      ...OPEN_CATALOG_SEED[0]!,
      previewUrl: "https://images.fabplane.com/artifacts/open-catalog/tensorfleet/koyomi-lvds-hat/thumb.webp",
      heroUrl: "https://images.fabplane.com/artifacts/open-catalog/tensorfleet/koyomi-lvds-hat/hero.webp",
    };
    expect(previewCandidateUrls(project)[0]).toBe("https://images.fabplane.com/artifacts/open-catalog/tensorfleet/koyomi-lvds-hat/thumb.webp");
    expect(previewCandidateUrls(project, "hero")[0]).toBe("https://images.fabplane.com/artifacts/open-catalog/tensorfleet/koyomi-lvds-hat/hero.webp");
  });

  test("resolveCatalogPreview never fetches GitHub even when the catalog entry points there", async () => {
    const prev = process.env["CATALOG_ASSET_DIR"];
    process.env["CATALOG_ASSET_DIR"] = "";
    const seen: string[] = [];
    try {
      const project = {
        ...OPEN_CATALOG_SEED.find((p) => p.id === "im-tomu/fomu-hardware")!,
        previewUrl: "https://opengraph.github.com/repo/im-tomu/fomu-hardware",
        photoUrl: "https://raw.githubusercontent.com/im-tomu/fomu-hardware/master/fomu.png",
        heroUrl: "https://github.com/im-tomu.png",
      };
      await resolveCatalogPreview(project, {
        cache: createPreviewCache(),
        fetchImpl: async (url) => {
          seen.push(String(url));
          return new Response("missing", { status: 404 });
        },
      });
      expect(seen.every((url) => url.startsWith("https://images.fabplane.com/"))).toBe(true);
      expect(seen.some((url) => url.includes("github"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env["CATALOG_ASSET_DIR"];
      else process.env["CATALOG_ASSET_DIR"] = prev;
    }
  });

  test("resolveCatalogPreview aborts oversized bodies without buffering the rest", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0xff);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const { heroUrl: _hero, ...base } = OPEN_CATALOG_SEED[0]!;
    const project = { ...base, previewUrl: "https://images.fabplane.com/artifacts/open-catalog/tensorfleet/koyomi-lvds-hat/huge.png" };
    const prev = process.env["CATALOG_ASSET_DIR"];
    process.env["CATALOG_ASSET_DIR"] = "";
    try {
      const image = await resolveCatalogPreview(project, {
        cache: createPreviewCache(),
        fetchImpl: async (url) => {
          if (String(url).includes("huge")) return new Response(stream);
          return new Response(png, { headers: { "content-type": "image/png" } });
        },
      });
      expect(image.contentType).toBe("image/png");
      expect(image.body[0]).toBe(0x89);
      expect(pulled).toBeGreaterThan(5_000_000);
      expect(pulled).toBeLessThan(5_000_000 + 64 * 1024 * 3);
    } finally {
      if (prev === undefined) delete process.env["CATALOG_ASSET_DIR"];
      else process.env["CATALOG_ASSET_DIR"] = prev;
    }
  });

  test("resolveCatalogPreview skips a declared Content-Length over the cap", async () => {
    const { heroUrl: _hero, ...base } = OPEN_CATALOG_SEED[0]!;
    const project = { ...base, previewUrl: "https://images.fabplane.com/artifacts/open-catalog/tensorfleet/koyomi-lvds-hat/huge.png" };
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const prev = process.env["CATALOG_ASSET_DIR"];
    process.env["CATALOG_ASSET_DIR"] = "";
    try {
      const image = await resolveCatalogPreview(project, {
        cache: createPreviewCache(),
        fetchImpl: async (url) => {
          if (String(url).includes("huge")) {
            return new Response(stream, { headers: { "content-length": "9000000" } });
          }
          return new Response(png, { headers: { "content-type": "image/png" } });
        },
      });
      expect(image.contentType).toBe("image/png");
      expect(cancelled).toBe(true);
    } finally {
      if (prev === undefined) delete process.env["CATALOG_ASSET_DIR"];
      else process.env["CATALOG_ASSET_DIR"] = prev;
    }
  });

  test("resolveCatalogPreview does not cache initials so a later CDN fetch can succeed", async () => {
    const prev = process.env["CATALOG_ASSET_DIR"];
    process.env["CATALOG_ASSET_DIR"] = "";
    const project = OPEN_CATALOG_SEED[1]!;
    const cache = createPreviewCache();
    try {
      const dead = await resolveCatalogPreview(project, {
        cache,
        fetchImpl: async () => new Response("Too many", { status: 200, headers: { "content-type": "image/png" } }),
      });
      expect(dead.contentType.startsWith("image/svg+xml")).toBe(true);

      const live = await resolveCatalogPreview(project, {
        cache,
        fetchImpl: async (url) => {
          expect(String(url).includes("github")).toBe(false);
          if (String(url).includes("images.fabplane.com")) {
            return new Response(png, { headers: { "content-type": "image/png" } });
          }
          return new Response("missing", { status: 404 });
        },
      });
      expect(live.contentType).toBe("image/png");
      expect(live.body[0]).toBe(0x89);
    } finally {
      if (prev === undefined) delete process.env["CATALOG_ASSET_DIR"];
      else process.env["CATALOG_ASSET_DIR"] = prev;
    }
  });

  test("resolveCatalogPreview caches a fetched image and falls back to SVG", async () => {
    const prev = process.env["CATALOG_ASSET_DIR"];
    process.env["CATALOG_ASSET_DIR"] = "";
    const project = OPEN_CATALOG_SEED[0]!;
    const cache = createPreviewCache();
    try {
      const image = await resolveCatalogPreview(project, {
        cache,
        fetchImpl: async () => new Response(png, { headers: { "content-type": "text/plain" } }),
      });
      expect(image.contentType).toBe("image/png");
      expect(image.body[0]).toBe(0x89);

      let fetches = 0;
      const cached = await resolveCatalogPreview(project, {
        cache,
        fetchImpl: async () => {
          fetches += 1;
          throw new Error("should not refetch");
        },
      });
      expect(fetches).toBe(0);
      expect(cached.body).toBe(image.body);

      const dead = await resolveCatalogPreview(project, {
        cache: createPreviewCache(),
        fetchImpl: async () => new Response("Too many", { status: 200, headers: { "content-type": "image/png" } }),
      });
      expect(dead.contentType.startsWith("image/svg+xml")).toBe(true);
      expect(new TextDecoder().decode(dead.body)).toContain("KL");
      expect(fallbackPreviewSvg(project.name).contentType.startsWith("image/svg+xml")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env["CATALOG_ASSET_DIR"];
      else process.env["CATALOG_ASSET_DIR"] = prev;
    }
  });
});

describe("order readiness", () => {
  const none: OrderCheckEvidence = {
    allowedDrcWarnings: [],
    hasBoardPcb: false,
    hasBoardSch: false,
    drc: null,
    erc: null,
    fabPackage: null,
  };
  const drcReport = (over: Partial<DrcReport> = {}): DrcReport => ({
    violations: [],
    unconnected: [],
    schematicParity: [],
    counts: { errors: 0, warnings: 0, unconnected: 0 },
    raw: {},
    ...over,
  });
  const ercReport = (errors = 0): ErcReport => ({ violations: [], counts: { errors, warnings: 0 }, raw: {} });
  const board = { ...none, hasBoardPcb: true };
  const cleanDrc = { report: drcReport(), inputsChanged: false };

  test("gerbers or a zip without board.kicad_pcb need no checks; board.kicad_pcb needs DRC", () => {
    expect(assessOrderReadiness([], none).ready).toBe(false);
    expect(assessOrderReadiness([{ path: "circuit.tsx" }], none).ready).toBe(false);
    expect(assessOrderReadiness([{ path: "exports/gerbers/F_Cu.gbr" }], none).ready).toBe(true);
    expect(assessOrderReadiness([{ path: "exports/fabrication.zip" }], none).ready).toBe(true);
    // A board verify_drc cannot check (other name, legacy routed json) does not block.
    expect(assessOrderReadiness([{ path: "hw/other.kicad_pcb" }], none).checks.drc).toBe("not_required");
    expect(assessOrderReadiness([{ path: "circuit.routed.json" }], none).ready).toBe(true);
    const blocked = assessOrderReadiness([{ path: "board.kicad_pcb" }], board);
    expect(blocked.ready).toBe(false);
    expect(blocked.checks).toEqual({ drc: "missing", erc: "not_required", fabPackage: "not_required" });
    expect(blocked.reasons.join(" ")).toContain("Run DRC");
  });

  test("fab package check is a soft gate: fail warns, does not block ready", () => {
    const gerbers = [{ path: "exports/gerbers/F_Cu.gbr" }];
    const missing = assessOrderReadiness(gerbers, none);
    expect(missing.ready).toBe(true);
    expect(missing.checks.fabPackage).toBe("missing");
    expect(missing.warnings.join(" ")).toContain("has not been checked");
    const failed = assessOrderReadiness(gerbers, {
      ...none,
      fabPackage: { overall: "fail", inputsChanged: false },
    });
    expect(failed.ready).toBe(true);
    expect(failed.checks.fabPackage).toBe("fail");
    expect(failed.warnings.join(" ")).toContain("reported failures");
    const stale = assessOrderReadiness(gerbers, {
      ...none,
      fabPackage: { overall: "pass", inputsChanged: true },
    });
    expect(stale.checks.fabPackage).toBe("stale");
    expect(stale.ready).toBe(true);
  });

  test("assembly artifacts never establish root-only order readiness", () => {
    const files = [{ path: "fabplane.assembly.json" }, { path: "boards/io.kicad_pcb" }, { path: "exports/fabrication.zip" }];
    const assembly = assessOrderReadiness(files, { ...board, drc: cleanDrc });
    expect(assembly.ready).toBe(false);
    expect(assembly.reasons.join(" ")).toContain("multi-board");
    // Direct disk evidence still blocks when the capped listing hides the manifest.
    expect(assessOrderReadiness([], { ...board, drc: cleanDrc, assemblyDeclared: true }).ready).toBe(false);
  });

  test("DRC must be fresh and pass the release gate", () => {
    expect(assessOrderReadiness([], { ...board, drc: cleanDrc }).ready).toBe(true);
    expect(assessOrderReadiness([], { ...board, drc: { ...cleanDrc, inputsChanged: true } }).checks.drc).toBe("stale");
    const errors = drcReport({ counts: { errors: 2, warnings: 0, unconnected: 0 } });
    expect(assessOrderReadiness([], { ...board, drc: { report: errors, inputsChanged: false } }).checks.drc).toBe("fail");
    const warning: DrcViolation = { rule: "silk", severity: "warning", description: "", items: [], coordinates: [], layers: [], nets: [], objectIds: [], affectedGeometry: [], signature: "sig-1" };
    const warned = { report: drcReport({ violations: [warning], counts: { errors: 0, warnings: 1, unconnected: 0 } }), inputsChanged: false };
    expect(assessOrderReadiness([], { ...board, drc: warned }).checks.drc).toBe("fail");
    expect(assessOrderReadiness([], { ...board, drc: warned, allowedDrcWarnings: ["sig-1"] }).checks.drc).toBe("pass");
  });

  test("ERC is required only with board.kicad_sch; a non-applicable report warns instead of blocking", () => {
    const sch = { ...board, drc: cleanDrc, hasBoardSch: true };
    expect(assessOrderReadiness([], sch).checks.erc).toBe("missing");
    expect(assessOrderReadiness([], { ...sch, erc: { report: ercReport(), inputsChanged: false } }).ready).toBe(true);
    expect(assessOrderReadiness([], { ...sch, erc: { report: ercReport(1), inputsChanged: false } }).checks.erc).toBe("fail");
    expect(assessOrderReadiness([], { ...sch, erc: { report: ercReport(), inputsChanged: true } }).checks.erc).toBe("stale");
    const incomplete = { ...ercReport(1), measurement: { evidenceLevel: "missing", applicability: false } };
    const warned = assessOrderReadiness([], { ...sch, erc: { report: incomplete, inputsChanged: false } });
    expect(warned.checks.erc).toBe("not_applicable");
    expect(warned.ready).toBe(true);
    expect(warned.warnings).toHaveLength(1);
  });

  describe("evidence loaded from disk", () => {
    const pcb = "(kicad_pcb)\n";
    const sheetText = "(kicad_sch (uuid \"root-1\"))\n";
    const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
    const project = async (files: Record<string, string>) => {
      const dir = await mkdtemp(join(tmpdir(), "fabdesk-order-"));
      for (const [path, text] of Object.entries(files)) await Bun.write(join(dir, path), text);
      return dir;
    };
    const drcJson = (boardText = pcb) => JSON.stringify({ ...drcReport(), pcbRevision: { sha256: sha(boardText) } });
    const sheets = [{ hierarchyPath: "/", nativePath: "board.kicad_sch", identity: "root-1" }];
    const ercJson = async (dir: string) =>
      JSON.stringify({
        ...ercReport(),
        measurement: {
          evidenceLevel: "measured",
          applicability: true,
          revisionStable: true,
          checkedRevision: await savedHierarchyRevision(dir, sheets),
          hierarchy: { referencedFiles: ["board.kicad_sch"], sheets },
        },
      });

    test("a clean drc.json counts even when the capped file listing omits it", async () => {
      const dir = await project({ "board.kicad_pcb": pcb, "reports/drc.json": drcJson() });
      // ProjectStore.listFiles stops at 2000 entries; reports/ and the board may not be among them.
      const listing = Array.from({ length: 2000 }, (_, i) => ({ path: `aaa/part-${i}.step` }));
      const readiness = assessOrderReadiness(listing, await loadOrderCheckEvidence(dir, []));
      expect(readiness.checks.drc).toBe("pass");
      expect(readiness.ready).toBe(true);
    });

    test("even a malformed assembly declaration blocks ordering without listing evidence", async () => {
      const dir = await project({ "fabplane.assembly.json": "{broken", "board.kicad_pcb": pcb, "reports/drc.json": drcJson() });
      const evidence = await loadOrderCheckEvidence(dir, []);
      expect(evidence.assemblyDeclared).toBe(true);
      const readiness = assessOrderReadiness([{ path: "exports/fabrication.zip" }], evidence);
      expect(readiness.ready).toBe(false);
      expect(readiness.reasons.join(" ")).toContain("multi-board");
    });

    test("editing the board makes DRC stale", async () => {
      const dir = await project({ "board.kicad_pcb": pcb, "reports/drc.json": drcJson() });
      await Bun.write(join(dir, "board.kicad_pcb"), "(kicad_pcb (edited))\n");
      expect(assessOrderReadiness([], await loadOrderCheckEvidence(dir, [])).checks.drc).toBe("stale");
    });

    test("a schematic in another folder (no board.kicad_sch) does not require ERC", async () => {
      const dir = await project({
        "board.kicad_pcb": pcb,
        "reports/drc.json": drcJson(),
        "hardware/main.kicad_sch": sheetText,
      });
      const readiness = assessOrderReadiness([{ path: "hardware/main.kicad_sch" }], await loadOrderCheckEvidence(dir, []));
      expect(readiness.checks.erc).toBe("not_required");
      expect(readiness.ready).toBe(true);
    });

    test("ERC freshness follows schematic content, not file times or autosaves", async () => {
      const dir = await project({ "board.kicad_pcb": pcb, "reports/drc.json": drcJson(), "board.kicad_sch": sheetText });
      await Bun.write(join(dir, "reports/erc.json"), await ercJson(dir));
      const later = new Date(Date.now() + 60_000);
      await utimes(join(dir, "board.kicad_sch"), later, later);
      await Bun.write(join(dir, "_autosave-board.kicad_sch"), "(kicad_sch (autosave))\n");
      await Bun.write(join(dir, "board-backups/board.kicad_sch"), "(kicad_sch (backup))\n");
      expect(assessOrderReadiness([], await loadOrderCheckEvidence(dir, [])).checks.erc).toBe("pass");
      await Bun.write(join(dir, "board.kicad_sch"), "(kicad_sch (uuid \"root-1\") (edited))\n");
      expect(assessOrderReadiness([], await loadOrderCheckEvidence(dir, [])).checks.erc).toBe("stale");
    });

    test("older ERC reports without sheet identities fall back to the measured files' times", async () => {
      const dir = await project({ "board.kicad_pcb": pcb, "reports/drc.json": drcJson(), "board.kicad_sch": sheetText });
      const earlier = new Date(Date.now() - 60_000);
      await utimes(join(dir, "board.kicad_sch"), earlier, earlier);
      await Bun.write(
        join(dir, "reports/erc.json"),
        JSON.stringify({ ...ercReport(), measurement: { hierarchy: { referencedFiles: ["board.kicad_sch", "libraries/lib.kicad_sch"] } } }),
      );
      await Bun.write(join(dir, "libraries/lib.kicad_sch"), "(kicad_sch)\n");
      expect(assessOrderReadiness([], await loadOrderCheckEvidence(dir, [])).checks.erc).toBe("pass");
      const later = new Date(Date.now() + 60_000);
      await utimes(join(dir, "board.kicad_sch"), later, later);
      expect(assessOrderReadiness([], await loadOrderCheckEvidence(dir, [])).checks.erc).toBe("stale");
    });
  });

  test("JLCPCB and PCBWay are enabled; laser and CNC are not", () => {
    expect(startOrderSession("jlcpcb").enabled).toBe(true);
    expect(startOrderSession("jlcpcb").steps.map((s) => s.title)).toContain("Check the fab package");
    expect(startOrderSession("pcbway").orderUrl).toContain("pcbway.com");
    expect(startOrderSession("laser").enabled).toBe(false);
    expect(startOrderSession("cnc").enabled).toBe(false);
  });
});

describe("remix import", () => {
  const dir = { value: "" };
  let store: Store;
  let projects: ProjectStore;

  beforeAll(async () => {
    dir.value = await mkdtemp(join(tmpdir(), "fabdesk-remix-"));
    store = Store.open(join(dir.value, "db.sqlite"));
    projects = new ProjectStore(store.projects, join(dir.value, "projects"), () => {}, { watch: false });
    await projects.init();
  });

  afterAll(() => {
    projects.close();
    store.close();
  });

  test("importFromGit registers a cloned tree as a project", async () => {
    const detail = await projects.importFromGit({
      name: "Koyomi remix",
      gitUrl: "https://github.com/TensorFleet/koyomi-lvds-hat.git",
      clone: async (_url, dest) => {
        await Bun.write(join(dest, "README.md"), "cloned\n");
        await Bun.write(join(dest, "board.kicad_pcb"), "(kicad_pcb)\n");
      },
    });
    expect(detail.name).toBe("Koyomi remix");
    expect(detail.files.some((f) => f.path === "board.kicad_pcb")).toBe(true);
    expect(detail.files.some((f) => f.path === "fabdesk.json")).toBe(true);
    const readiness = assessOrderReadiness(detail.files, await loadOrderCheckEvidence(detail.path, []));
    expect(readiness.hasKicadPcb).toBe(true);
    expect(readiness.checks.drc).toBe("missing");
  });
});
