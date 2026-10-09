import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRouterCatalog } from "../src/routers/catalog";
import { createRouterRegistry } from "../src/routers/registry";
import {
  TRACEMAKER_BINARY_RELEASE_REPO,
  TRACEMAKER_BINARY_RELEASE_TAG,
  artifactFormatForFilename,
  defaultTraceMakerBinaryRelease,
  detectTraceMakerPlatform,
  parseTraceMakerManifest,
  resolveTraceMakerInstallArtifact,
  selectTraceMakerAsset,
  traceMakerAssetToArtifact,
  type TraceMakerManifest,
} from "../src/routers/tracemaker-release";

const servers: Array<{ stop(): void }> = [];
afterAll(() => {
  for (const server of servers) server.stop();
});

const SAMPLE_MANIFEST: TraceMakerManifest = {
  name: "tracemaker",
  builtAt: "2026-10-09T04:17:00.000Z",
  upstream: {
    repository: "https://github.com/DingoOz/TraceMaker",
    tag: "v0.9.0",
    commit: "24c847772e57ea8888e2cfe4bbf1aa00666390a4",
    license: "GPL-3.0-or-later",
    sourceUrl: "https://github.com/DingoOz/TraceMaker/archive/24c847772e57ea8888e2cfe4bbf1aa00666390a4.tar.gz",
  },
  assets: [
    {
      platform: "linux-x86_64",
      filename: "tracemaker-linux-x86_64.tar.gz",
      url: "https://github.com/TensorFleet/fabdesk/releases/download/tracemaker-v0.9.0-24c8477/tracemaker-linux-x86_64.tar.gz",
      sha256: "a".repeat(64),
      bytes: 4096,
      executable: "tracemaker",
      linkage: "bundled-libzstd-libsqlite3",
    },
    {
      platform: "macos-arm64",
      filename: "tracemaker-macos-arm64.tar.gz",
      url: "https://github.com/TensorFleet/fabdesk/releases/download/tracemaker-v0.9.0-24c8477/tracemaker-macos-arm64.tar.gz",
      sha256: "b".repeat(64),
      bytes: 5120,
      executable: "tracemaker",
    },
  ],
};

const SOURCE = {
  url: "https://example.test/tracemaker-source.tar.gz",
  sha256: "c".repeat(64),
  bytes: 20_863_170,
  filename: "tracemaker-0.8.0.tar.gz",
  format: "tar.gz" as const,
  executable: "tracemaker",
};

describe("detectTraceMakerPlatform", () => {
  test("maps Node platform/arch pairs used by fabdesk", () => {
    expect(detectTraceMakerPlatform({ platform: "linux", arch: "x64" })).toBe("linux-x86_64");
    expect(detectTraceMakerPlatform({ platform: "darwin", arch: "arm64" })).toBe("macos-arm64");
    expect(detectTraceMakerPlatform({ platform: "darwin", arch: "x64" })).toBe("macos-x86_64");
    expect(detectTraceMakerPlatform({ platform: "win32", arch: "x64" })).toBe("windows-x86_64");
    expect(detectTraceMakerPlatform({ platform: "linux", arch: "arm64" })).toBeNull();
    expect(detectTraceMakerPlatform({ platform: "freebsd", arch: "x64" })).toBeNull();
  });
});

describe("parseTraceMakerManifest / selectTraceMakerAsset", () => {
  test("accepts a weekly release manifest and picks the platform asset", () => {
    const parsed = parseTraceMakerManifest(SAMPLE_MANIFEST);
    expect(parsed.upstream.tag).toBe("v0.9.0");
    const linux = selectTraceMakerAsset(parsed, "linux-x86_64");
    expect(linux.filename).toBe("tracemaker-linux-x86_64.tar.gz");
    expect(traceMakerAssetToArtifact(linux)).toEqual({
      url: linux.url,
      sha256: linux.sha256,
      bytes: 4096,
      filename: linux.filename,
      format: "tar.gz",
      executable: "tracemaker",
    });
    expect(artifactFormatForFilename("tracemaker-windows-x86_64.zip")).toBe("zip");
  });

  test("rejects a truncated checksum and a missing platform with a clear error", () => {
    const linux = SAMPLE_MANIFEST.assets[0];
    if (!linux) throw new Error("fixture missing linux asset");
    expect(() => parseTraceMakerManifest({ ...SAMPLE_MANIFEST, assets: [] })).not.toThrow();
    expect(() =>
      parseTraceMakerManifest({
        ...SAMPLE_MANIFEST,
        assets: [{ ...linux, sha256: "deadbeef" }],
      }),
    ).toThrow(/invalid TraceMaker manifest/);
    expect(() => selectTraceMakerAsset(SAMPLE_MANIFEST, "windows-x86_64")).toThrow(
      /No TraceMaker binary is published for windows-x86_64/,
    );
    expect(() => selectTraceMakerAsset(SAMPLE_MANIFEST, "macos-x86_64")).toThrow(
      /Published platforms: linux-x86_64, macos-arm64/,
    );
  });
});

describe("resolveTraceMakerInstallArtifact", () => {
  test("uses the manifest binary when the platform is published", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json(SAMPLE_MANIFEST);
      },
    });
    servers.push(server);
    const resolved = await resolveTraceMakerInstallArtifact({
      source: SOURCE,
      binaryRelease: {
        repo: "TensorFleet/fabdesk",
        tag: "tracemaker-latest",
        manifestUrl: `http://127.0.0.1:${server.port}/manifest.json`,
      },
      platform: "linux",
      arch: "x64",
    });
    expect(resolved.origin).toBe("binary");
    expect(resolved.platform).toBe("linux-x86_64");
    expect(resolved.version).toBe("0.9.0");
    expect(resolved.artifact.url).toContain("tracemaker-linux-x86_64.tar.gz");
    expect(resolved.artifact.sha256).toBe("a".repeat(64));
  });

  test("falls back to the source tarball when the platform is missing or the release is unpublished", async () => {
    const missingPlatform = await resolveTraceMakerInstallArtifact({
      source: SOURCE,
      binaryRelease: {
        repo: "TensorFleet/fabdesk",
        tag: "tracemaker-latest",
        manifestUrl: "http://127.0.0.1:1/unused",
      },
      platform: "linux",
      arch: "arm64",
    });
    expect(missingPlatform.origin).toBe("source");
    expect(missingPlatform.artifact).toEqual(SOURCE);
    expect(missingPlatform.warning).toMatch(/No TraceMaker binary is published for linux-arm64/);

    const unpublished = Bun.serve({
      port: 0,
      fetch() {
        return new Response("missing", { status: 404 });
      },
    });
    servers.push(unpublished);
    const fallback = await resolveTraceMakerInstallArtifact({
      source: SOURCE,
      binaryRelease: {
        repo: "TensorFleet/fabdesk",
        tag: "tracemaker-latest",
        manifestUrl: `http://127.0.0.1:${unpublished.port}/manifest.json`,
      },
      platform: "darwin",
      arch: "arm64",
    });
    expect(fallback.origin).toBe("source");
    expect(fallback.warning).toMatch(/not published yet/);
  });

  test("FABDESK_TRACEMAKER_URL keeps the explicit source artifact", async () => {
    const resolved = await resolveTraceMakerInstallArtifact({
      source: SOURCE,
      binaryRelease: defaultTraceMakerBinaryRelease(),
      env: { FABDESK_TRACEMAKER_URL: SOURCE.url },
      platform: "linux",
      arch: "x64",
    });
    expect(resolved.origin).toBe("source");
    expect(resolved.artifact.url).toBe(SOURCE.url);
  });
});

describe("default catalog + registry install", () => {
  test("default catalog points at the rolling fabdesk release unless the source URL is overridden", () => {
    const [plain] = [defaultRouterCatalog({}).find((row) => row.id === "tracemaker")];
    expect(plain?.binaryRelease).toEqual({
      repo: TRACEMAKER_BINARY_RELEASE_REPO,
      tag: TRACEMAKER_BINARY_RELEASE_TAG,
      manifestUrl: `https://github.com/${TRACEMAKER_BINARY_RELEASE_REPO}/releases/download/${TRACEMAKER_BINARY_RELEASE_TAG}/manifest.json`,
    });
    const overridden = defaultRouterCatalog({ FABDESK_TRACEMAKER_URL: "http://127.0.0.1/tm.tgz" }).find(
      (row) => row.id === "tracemaker",
    );
    expect(overridden?.binaryRelease).toBeUndefined();
    expect(overridden?.artifact?.url).toBe("http://127.0.0.1/tm.tgz");
  });

  test("install downloads the platform binary from the manifest and verifies the checksum", async () => {
    const body = Buffer.from("#!/bin/sh\nexit 0\n");
    const sha = createHash("sha256").update(body).digest("hex");
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path.endsWith("/manifest.json")) {
          return Response.json({
            ...SAMPLE_MANIFEST,
            assets: [
              {
                platform: detectTraceMakerPlatform() ?? "linux-x86_64",
                filename: "tracemaker",
                url: `http://127.0.0.1:${server.port}/tracemaker`,
                sha256: sha,
                bytes: body.length,
                format: "file",
                executable: "tracemaker",
              },
            ],
          });
        }
        return new Response(body);
      },
    });
    servers.push(server);
    const home = await mkdtemp(join(tmpdir(), "fabdesk-tm-bin-"));
    const registry = createRouterRegistry({
      home,
      catalog: [
        {
          id: "fab_router",
          displayName: "fab_router",
          description: "bundled",
          strengths: [],
          license: "bundled",
          version: "bundled",
          homepage: "https://example.test",
          install: "bundled",
        },
        {
          id: "tracemaker",
          displayName: "TraceMaker",
          description: "on demand",
          strengths: ["dense pads"],
          license: "GPL-3.0-or-later",
          version: "0.8.0",
          homepage: "https://github.com/DingoOz/TraceMaker",
          install: "download",
          binaryRelease: {
            repo: "TensorFleet/fabdesk",
            tag: "tracemaker-latest",
            manifestUrl: `http://127.0.0.1:${server.port}/manifest.json`,
          },
          artifact: SOURCE,
        },
      ],
    });
    const installed = await registry.install("tracemaker");
    expect(installed.state).toBe("installed");
    expect(installed.ready).toBe(true);
    expect(installed.versionInstalled).toBe("0.9.0");
    expect(installed.path).toMatch(/tracemaker$/);
    expect(registry.executable("tracemaker")).toBe(installed.path);
  });

  test("TRACEMAKER_BIN still wins over a published binary", async () => {
    const home = await mkdtemp(join(tmpdir(), "fabdesk-tm-env-"));
    const binDir = await mkdtemp(join(tmpdir(), "fabdesk-tm-bin-"));
    const bin = join(binDir, "tracemaker");
    await writeFile(bin, "#!/bin/sh\nexit 0\n");
    await chmod(bin, 0o755);
    const registry = createRouterRegistry({
      home,
      env: { TRACEMAKER_BIN: bin },
      catalog: [
        {
          id: "fab_router",
          displayName: "fab_router",
          description: "bundled",
          strengths: [],
          license: "bundled",
          version: "bundled",
          homepage: "https://example.test",
          install: "bundled",
        },
        {
          id: "tracemaker",
          displayName: "TraceMaker",
          description: "on demand",
          strengths: [],
          license: "GPL-3.0-or-later",
          version: "0.8.0",
          homepage: "https://example.test",
          install: "download",
          binaryRelease: defaultTraceMakerBinaryRelease(),
          artifact: SOURCE,
        },
      ],
    });
    expect(registry.get("tracemaker").path).toBe(bin);
    expect(registry.get("tracemaker").ready).toBe(true);
  });
});
