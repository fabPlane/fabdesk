import { expect, test } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "../src";
import { createRouterRegistry } from "../src/routers/registry";
import { contextFactory, mockServices, tempProject } from "./mock-services";

function call(
  registry: ReturnType<typeof createRegistry>,
  factory: ReturnType<typeof contextFactory>,
  args: Record<string, unknown>,
) {
  return registry.invoke("route_run", args, (ref) =>
    factory({
      def: registry.get("route_run")!,
      projectRef: ref,
      signal: new AbortController().signal,
      progress: () => {},
    }),
  );
}

test("route_run router=tracemaker errors with an install hint when it is not installed", async () => {
  const project = await tempProject("tm-missing");
  await writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb (net \"N1\"))");
  const home = await mkdtemp(join(tmpdir(), "fabdesk-opt-"));
  const services = mockServices([project], {
    routers: createRouterRegistry({
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
        },
      ],
    }),
  });
  const registry = createRegistry();
  await expect(call(registry, contextFactory(services, project), { router: "tracemaker", waitMs: 0 })).rejects.toThrow(
    /TraceMaker is not installed/,
  );
});

test("unpinned route_run still starts Freerouting, not TraceMaker", async () => {
  const project = await tempProject("tm-default");
  const { router: _router, ...manifest } = project.manifest();
  const unpinned = { ...project, manifest: () => ({ ...manifest }) };
  await writeFile(join(unpinned.dir, "board.kicad_pcb"), "(kicad_pcb (net \"N1\"))");
  await writeFile(join(unpinned.dir, "board.kicad_pro"), "pro");
  const base = mockServices([unpinned]);
  const calls: string[] = [];
  const services = mockServices([unpinned], {
    design: {
      ...base.design,
      status: async () => ({ url: "mock", ok: true, routers: { freerouting: { ok: true } } }),
      route: async (_dir, opts) => {
        calls.push(opts.router);
        return {
          tracks: 1,
          vias: 0,
          claimedVias: 0,
          routed: 1,
          total: 1,
          trackLengthNm: 1,
          elapsedMs: 1,
          wallMs: 1,
          timedOut: false,
          message: "complete",
          unrouted: [],
          log: [],
        };
      },
    },
  });
  const registry = createRegistry();
  await call(registry, contextFactory(services, unpinned), { waitMs: 1000 });
  expect(calls).toEqual(["freerouting"]);
});

test("TRACEMAKER_BIN makes router=tracemaker selectable without a catalog download", async () => {
  const project = await tempProject("tm-bin");
  await writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb (net \"N1\"))");
  const home = await mkdtemp(join(tmpdir(), "fabdesk-opt-"));
  const binDir = await mkdtemp(join(tmpdir(), "fabdesk-tmbin-"));
  const bin = join(binDir, "tracemaker");
  await writeFile(bin, "#!/bin/sh\nexit 0\n");
  await chmod(bin, 0o755);
  const routers = createRouterRegistry({ home, env: { TRACEMAKER_BIN: bin } });
  expect(routers.get("tracemaker").ready).toBe(true);
  const services = mockServices([project], { routers });
  const registry = createRegistry();
  const output = await call(registry, contextFactory(services, project), {
    router: "tracemaker",
    waitMs: 0,
  });
  expect(output.text).toMatch(/tracemaker/);
});

test("a saved default that is not ready falls back to automatic routing instead of failing every route", async () => {
  const project = await tempProject("tm-stale-default");
  const { router: _router, ...manifest } = project.manifest();
  const unpinned = { ...project, manifest: () => ({ ...manifest }) };
  await writeFile(join(unpinned.dir, "board.kicad_pcb"), "(kicad_pcb (net \"N1\"))");
  await writeFile(join(unpinned.dir, "board.kicad_pro"), "pro");
  const home = await mkdtemp(join(tmpdir(), "fabdesk-stale-"));
  const routers = createRouterRegistry({
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
        strengths: [],
        license: "GPL-3.0-or-later",
        version: "0.8.0",
        homepage: "https://example.test",
        install: "download",
      },
    ],
  });
  const base = mockServices([unpinned]);
  const calls: string[] = [];
  const services = mockServices([unpinned], {
    routers,
    settings: () => ({ ...base.settings(), preferredRouter: "tracemaker" }),
    design: {
      ...base.design,
      status: async () => ({ url: "mock", ok: true, routers: { freerouting: { ok: true } } }),
      route: async (_dir, opts) => {
        calls.push(opts.router);
        return {
          tracks: 1, vias: 0, claimedVias: 0, routed: 1, total: 1, trackLengthNm: 1, elapsedMs: 1, wallMs: 1,
          timedOut: false, message: "complete", unrouted: [], log: [],
        };
      },
    },
  });
  const registry = createRegistry();
  const output = await call(registry, contextFactory(services, unpinned), { waitMs: 1000 });
  expect(calls).toEqual(["freerouting"]);
  expect(output.text).toMatch(/Default router TraceMaker is not ready/);
  // an explicit request still gets the install hint
  await expect(call(registry, contextFactory(services, unpinned), { router: "tracemaker", waitMs: 0 })).rejects.toThrow(
    /TraceMaker is not installed/,
  );
});
