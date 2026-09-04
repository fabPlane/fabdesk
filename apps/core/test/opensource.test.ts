import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db";
import { catalogPreviewUrl, isGitHubAssetHost } from "@fabdesk/protocol";
import { allowedCloneUrl, fetchOpenCatalog, findCatalogProject } from "../src/opensource/catalog";
import { assessOrderReadiness, startOrderSession } from "../src/opensource/order";
import {
  createPreviewCache,
  fallbackPreviewSvg,
  isRateLimitedPreviewHost,
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
    expect(previewCandidateUrls(og)).toEqual(["https://images.fabplane.com/artifacts/open-catalog/im-tomu/fomu-hardware/preview.webp"]);
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
      previewUrl: "https://example.com/thumb.png",
      heroUrl: "https://example.com/hero.png",
    };
    expect(previewCandidateUrls(project)[0]).toBe("https://example.com/thumb.png");
    expect(previewCandidateUrls(project, "hero")[0]).toBe("https://example.com/hero.png");
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
    const project = { ...base, previewUrl: "https://example.com/huge.png" };
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
  });

  test("resolveCatalogPreview skips a declared Content-Length over the cap", async () => {
    const { heroUrl: _hero, ...base } = OPEN_CATALOG_SEED[0]!;
    const project = { ...base, previewUrl: "https://example.com/huge.png" };
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
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
  });

  test("resolveCatalogPreview caches a fetched image and falls back to SVG", async () => {
    const project = OPEN_CATALOG_SEED[0]!;
    const cache = createPreviewCache();
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
  });
});

describe("order readiness", () => {
  test("is ready when gerbers, a zip, KiCad, or a routed board exist", () => {
    expect(assessOrderReadiness([]).ready).toBe(false);
    expect(assessOrderReadiness([{ path: "circuit.tsx" }]).ready).toBe(false);
    expect(assessOrderReadiness([{ path: "board.kicad_pcb" }]).ready).toBe(true);
    expect(assessOrderReadiness([{ path: "exports/gerbers/F_Cu.gbr" }]).ready).toBe(true);
    expect(assessOrderReadiness([{ path: "exports/fabrication.zip" }]).ready).toBe(true);
    expect(assessOrderReadiness([{ path: "circuit.routed.json" }]).ready).toBe(true);
  });

  test("JLCPCB and PCBWay are enabled; laser and CNC are not", () => {
    expect(startOrderSession("jlcpcb").enabled).toBe(true);
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
    expect(assessOrderReadiness(detail.files).ready).toBe(true);
  });
});
