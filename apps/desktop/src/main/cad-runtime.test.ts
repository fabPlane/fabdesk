import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  CAD_BRIDGE_COMMIT,
  CAD_FREECAD_COMMIT,
  CAD_RELEASE,
  CadRuntimeConsent,
  CadRuntimeManager,
  validateCadManifest,
} from "./cad-runtime";
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const payload = Buffer.from("signed engine fixture");
const base = `https://github.com/fabPlane/FreeCAD/releases/download/${CAD_RELEASE}/`;
const manifest = {
  format: 1,
  version: CAD_RELEASE,
  target: "darwin-arm64",
  minimumOS: "15.0",
  downloadBytes: payload.length,
  installedBytes: 1000,
  sha256: createHash("sha256").update(payload).digest("hex"),
  url: base + "cad-runtime-darwin-arm64.zip",
  freecadCommit: CAD_FREECAD_COMMIT,
  fabCadCommit: CAD_BRIDGE_COMMIT,
  sourceUrl: `https://github.com/fabPlane/FreeCAD/releases/tag/${CAD_RELEASE}`,
  sourcesUrl: base + "cad-runtime-sources.tar.gz",
  licensesUrl: base + "NOTICE.txt",
  sourcesSha256: "a".repeat(64),
  licensesSha256: "b".repeat(64),
};
async function fixture(
  overrides: Partial<ConstructorParameters<typeof CadRuntimeManager>[0]> = {},
) {
  const cache = await mkdtemp(join(tmpdir(), "cad-consent-test-"));
  dirs.push(cache);
  let engineRequests = 0,
    metadataRequests = 0,
    activations = 0;
  const deps = {
    cache,
    target: "darwin-arm64",
    supportedOS: true,
    fetch: (async (url: string | URL | Request) => {
      if (String(url).endsWith(".json")) {
        metadataRequests++;
        return Response.json(manifest);
      }
      engineRequests++;
      return new Response(payload);
    }) as typeof fetch,
    verify: async (app: string) => {
      const path = join(app, "bundle.json");
      await readFile(path);
      return path;
    },
    unpack: async (_zip: string, dir: string) => {
      await mkdir(join(dir, "CADRuntime.app"));
      await writeFile(join(dir, "CADRuntime.app", "bundle.json"), "verified");
    },
    activate: async (_path: string) => {
      activations++;
    },
    ...overrides,
  };
  return {
    cache,
    deps,
    manager: new CadRuntimeManager(deps),
    counts: () => ({ engineRequests, metadataRequests, activations }),
  };
}
test("first CAD use fetches metadata only; Later survives restart and manual Download works", async () => {
  const f = await fixture();
  expect((await f.manager.initialize()).status).toBe("missing");
  expect(f.counts().metadataRequests).toBe(0);
  expect((await f.manager.prepare()).status).toBe("consent");
  expect(f.counts().engineRequests).toBe(0);
  await f.manager.defer();
  const next = new CadRuntimeManager(f.deps);
  expect((await next.prepare()).status).toBe("deferred");
  expect(f.counts().engineRequests).toBe(0);
  expect((await next.download()).status).toBe("ready");
  expect(f.counts().engineRequests).toBe(1);
  expect((await new CadRuntimeManager(f.deps).initialize()).status).toBe("ready");
  expect(f.counts().engineRequests).toBe(1);
});
test("download cannot start without a prepared offer and repeated clicks share one installation", async () => {
  const f = await fixture();
  await f.manager.download();
  expect(f.counts().engineRequests).toBe(0);
  await f.manager.prepare();
  const a = f.manager.download(),
    b = f.manager.download();
  expect(a).toBe(b);
  expect((await a).status).toBe("ready");
  expect(f.counts().engineRequests).toBe(1);
  await f.manager.download();
  expect(f.counts().engineRequests).toBe(1);
});
test("startup discovery and first CAD use share slow verification and activation", async () => {
  let verificationStarted!: () => void;
  const started = new Promise<void>((resolve) => { verificationStarted = resolve; });
  let finishVerification!: () => void;
  const gate = new Promise<void>((resolve) => { finishVerification = resolve; });
  let verifications = 0;
  const f = await fixture({
    verify: async () => {
      verifications++;
      verificationStarted();
      await gate;
      return "verified-manifest";
    },
  });
  await mkdir(join(f.cache, CAD_RELEASE, "CADRuntime.app"), { recursive: true });
  const startup = f.manager.initialize();
  await started;
  expect(f.manager.initialize()).toBe(startup);
  const firstUse = f.manager.prepare();
  expect(f.manager.prepare()).toBe(firstUse);
  expect(f.counts()).toEqual({ engineRequests: 0, metadataRequests: 0, activations: 0 });
  finishVerification();
  expect((await startup).status).toBe("ready");
  expect((await firstUse).status).toBe("ready");
  expect(verifications).toBe(1);
  expect(f.counts()).toEqual({ engineRequests: 0, metadataRequests: 0, activations: 1 });
});
test("overlapping first use preserves a discovery verification failure without offering a download", async () => {
  let verificationStarted!: () => void;
  const started = new Promise<void>((resolve) => { verificationStarted = resolve; });
  let failVerification!: () => void;
  const gate = new Promise<void>((resolve) => { failVerification = resolve; });
  const f = await fixture({
    verify: async () => {
      verificationStarted();
      await gate;
      throw new Error("invalid signature");
    },
  });
  await mkdir(join(f.cache, CAD_RELEASE, "CADRuntime.app"), { recursive: true });
  const startup = f.manager.initialize();
  await started;
  const firstUse = f.manager.prepare();
  failVerification();
  expect((await startup).status).toBe("error");
  expect((await firstUse).message).toContain("invalid signature");
  expect(f.counts()).toEqual({ engineRequests: 0, metadataRequests: 0, activations: 0 });
});
test("unsupported platform/OS and ordinary GUI app do not masquerade as an API engine", async () => {
  for (const overrides of [{ target: "linux-x64" }, { supportedOS: false }]) {
    const f = await fixture(overrides);
    expect((await f.manager.prepare()).status).toBe("unsupported");
    expect(f.counts().metadataRequests).toBe(0);
  }
  const f = await fixture({
    verify: async () => {
      throw new Error("incompatible API engine");
    },
  });
  await mkdir(join(f.cache, CAD_RELEASE, "CADRuntime.app"), { recursive: true });
  expect((await f.manager.initialize()).message).toContain("incompatible");
  expect(f.counts().activations).toBe(0);
});
test("offline errors and unpublished assets leave PCB available and allow explicit retry", async () => {
  let offline = true;
  const f = await fixture({
    fetch: (async () => {
      if (offline) throw new Error("offline");
      return Response.json(manifest);
    }) as typeof fetch,
  });
  expect((await f.manager.prepare()).status).toBe("error");
  expect(f.manager.state().message).toContain("PCB remains available");
  offline = false;
  expect((await f.manager.prepare()).status).toBe("consent");
  const missing = await fixture({
    fetch: (async () => new Response(null, { status: 404 })) as typeof fetch,
  });
  expect((await missing.manager.prepare()).message).toContain("not been published");
});
test("checksum and signature failures never activate a runtime and clean all partials", async () => {
  for (const badSignature of [false, true]) {
    const f = await fixture({
      ...(badSignature
        ? {
            verify: async () => {
              throw new Error("signature invalid");
            },
          }
        : {
            fetch: (async (url: unknown) =>
              String(url).endsWith(".json")
                ? Response.json(manifest)
                : new Response(Buffer.from("wrong"))) as typeof fetch,
          }),
    });
    await f.manager.prepare();
    expect((await f.manager.download()).status).toBe("error");
    expect(f.counts().activations).toBe(0);
    expect(
      (await readdir(f.cache)).filter((p) => p.startsWith(".install-") || p === "install.lock"),
    ).toEqual([]);
  }
});
test("cancel cleans partials, stores Later, and retry completes", async () => {
  let blocked = true;
  const f = await fixture({
    fetch: (async (url: unknown, opts: RequestInit) => {
      if (String(url).endsWith(".json")) return Response.json(manifest);
      if (blocked)
        return await new Promise<Response>((_resolve, reject) =>
          opts.signal!.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          }),
        );
      return new Response(payload);
    }) as typeof fetch,
  });
  await f.manager.prepare();
  const pending = f.manager.download();
  while (f.manager.state().status !== "downloading") await Bun.sleep(1);
  await f.manager.defer();
  expect((await pending).status).toBe("deferred");
  expect(
    (await readdir(f.cache)).filter((p) => p.startsWith(".install-") || p === "install.lock"),
  ).toEqual([]);
  blocked = false;
  expect((await f.manager.download()).status).toBe("ready");
});
test("restart removes abandoned partials without deleting a good installation", async () => {
  const f = await fixture();
  await mkdir(join(f.cache, ".install-dead"));
  await writeFile(join(f.cache, ".install-dead", "partial"), "x");
  await writeFile(join(f.cache, "install.lock"), "2147483646");
  await f.manager.initialize();
  expect(await readdir(f.cache)).toEqual([]);
});
test("manifest cannot redirect to arbitrary hosts or choose a different API/architecture", () => {
  expect(validateCadManifest(manifest).target).toBe("darwin-arm64");
  for (const change of [
    { url: "https://evil.example/runtime.zip" },
    { target: "darwin-x64" },
    { freecadCommit: "wrong" },
    { fabCadCommit: "wrong" },
    { sha256: "x" },
    { downloadBytes: 0 },
  ])
    expect(() => validateCadManifest({ ...manifest, ...change })).toThrow();
});

test("native consent declines without a download and concurrent requests share one dialog", async () => {
  const f = await fixture();
  await f.manager.prepare();
  let dialogs = 0;
  let resolve!: (allowed: boolean) => void;
  const consent = new CadRuntimeConsent(f.manager, async () => {
    dialogs++;
    return new Promise<boolean>((r) => {
      resolve = r;
    });
  });
  const a = consent.request(),
    b = consent.request();
  expect(a).toBe(b);
  expect(dialogs).toBe(1);
  resolve(false);
  expect((await a).status).toBe("deferred");
  expect(f.counts().engineRequests).toBe(0);
  expect((await new CadRuntimeManager(f.deps).prepare()).status).toBe("deferred");
});

test("insufficient disk space prevents downloading and leaves PCB usable", async () => {
  const f = await fixture({ freeBytes: async () => 0 });
  await f.manager.prepare();
  expect((await f.manager.download()).message).toContain("free space");
  expect(f.counts().engineRequests).toBe(0);
});

test("installed runtime failure stays an error; retry activates without offering a download", async () => {
  let fail = true;
  const f = await fixture({
    verify: async () => {
      if (fail) throw new Error("bridge stopped");
      return "verified";
    },
  });
  await mkdir(join(f.deps.cache, CAD_RELEASE, "CADRuntime.app"), { recursive: true });
  expect((await f.manager.prepare()).status).toBe("error");
  expect(f.manager.state().offer).toBeUndefined();
  expect(f.counts().metadataRequests).toBe(0);
  fail = false;
  expect((await f.manager.prepare()).status).toBe("ready");
  expect(f.counts().engineRequests).toBe(0);
});

test("cancel during native consent prevents a late approval from downloading", async () => {
  const f = await fixture();
  await f.manager.prepare();
  let approve!: (allowed: boolean) => void;
  const consent = new CadRuntimeConsent(f.manager, () => new Promise((r) => (approve = r)));
  const request = consent.request();
  consent.cancel();
  await f.manager.defer();
  approve(true);
  expect((await request).status).toBe("deferred");
  expect(f.counts().engineRequests).toBe(0);
});

test("a missing executable in an installed runtime is an error, not a new install offer", async () => {
  const f = await fixture({
    verify: async () => {
      throw Object.assign(new Error("missing executable"), { code: "ENOENT" });
    },
  });
  await mkdir(join(f.deps.cache, CAD_RELEASE, "CADRuntime.app"), { recursive: true });
  expect((await f.manager.prepare()).status).toBe("error");
  expect(f.counts().metadataRequests).toBe(0);
});

test("explicit reconnect re-verifies and reactivates installed runtime without a download", async () => {
  const f = await fixture();
  await f.manager.prepare();
  await f.manager.download();
  const count = f.counts();
  expect((await f.manager.reconnect()).status).toBe("ready");
  expect(f.counts().activations).toBe(count.activations + 1);
  expect(f.counts().engineRequests).toBe(count.engineRequests);
});
