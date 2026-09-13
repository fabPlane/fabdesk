import { describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { ToolError, createRegistry, defineTool, jailPath, toolsMarkdown } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

describe("registry", () => {
  test("v1 tool set and naming", () => {
    const reg = createRegistry();
    const names = reg.list().map((t) => t.name);
    expect(names).toEqual([
      "load_toolset",
      "project_status",
      "circuit_build",
      "circuit_place",
      "circuit_read_errors",
      "route_run",
      "verify_drc",
      "render_board",
      "project_read_file",
      "project_write_file",
      "project_list_sketches",
      "project_set_board",
      "project_import_kicad",
      "circuit_query",
      "circuit_search_parts",
      "route_status",
      "route_cancel",
      "route_unroute",
      "route_scope",
      "kicad_stats",
      "verify_erc",
      "verify_gate",
      "verify_viagrid",
      "render_schematic_svg",
      "render_pcb_svg",
      "render_glb",
      "export_gerbers",
      "export_drill",
      "export_pos",
      "export_bom",
      "export_netlist",
      "export_zip",
      "export_dxf",
      "sim_spice_netlist",
      "sim_run",
      "app_state",
      "app_screenshot",
      "app_find",
      "app_click",
      "app_type",
      "app_key",
      "app_select_project",
      "app_open_tab",
      "app_open_thread",
      "app_new_chat",
      "app_send_message",
      "app_cinema",
      "app_wait_for",
      "app_eval",
    ]);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(reg.byToolset("core").length).toBe(8);
    expect(() =>
      defineTool({
        name: "bad.name",
        toolset: "core",
        title: "",
        description: "",
        inputSchema: {},
        annotations: {},
        handler: async () => ({}),
      }),
    ).toThrow();
  });

  test("manifest has JSON schema with project arg for project tools only", () => {
    const reg = createRegistry();
    const m = reg.manifest();
    const build = m.find((e) => e.name === "circuit_build")!;
    expect(build.longRunning).toBe(true);
    expect((build.inputSchema["properties"] as Record<string, unknown>)["project"]).toBeDefined();
    const load = m.find((e) => e.name === "load_toolset")!;
    expect((load.inputSchema["properties"] as Record<string, unknown>)["project"]).toBeUndefined();
    expect(load.inputSchema["required"] as string[]).toEqual(["toolset"]);
  });

  test("invoke validates args and requires a project", async () => {
    const reg = createRegistry();
    const project = await tempProject();
    const services = mockServices([project]);
    const noProject = contextFactory(services, null);
    await expect(
      reg.invoke("project_status", {}, (ref) =>
        noProject({
          def: reg.get("project_status")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      ),
    ).rejects.toBeInstanceOf(ToolError);
    const out = await reg.invoke("project_status", { project: project.id }, (ref) =>
      noProject({
        def: reg.get("project_status")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
    );
    expect(out.text).toContain(`Project "demo"`);
    await expect(
      reg.invoke("circuit_query", { select: "nope", project: project.id }, (ref) =>
        noProject({
          def: reg.get("circuit_query")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      ),
    ).rejects.toThrow(/invalid arguments/);
  });

  test("build → route → query end to end with mocks", async () => {
    const reg = createRegistry();
    const project = await tempProject();
    const services = mockServices([project]);
    const factory = contextFactory(services, project);
    const call = (name: string, args: Record<string, unknown> = {}) =>
      reg.invoke(name, args, (ref) =>
        factory({
          def: reg.get(name)!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      );
    const build = await call("circuit_build");
    expect(build.isError).toBeFalsy();
    expect(await Bun.file(join(project.dir, "board.kicad_pcb")).exists()).toBe(true);
    const route = await call("route_run", { timeoutMs: 5000 });
    expect(route.isError).toBeFalsy();
    const json = route.json as { runId: string; routed: number; total: number; open: string[] };
    expect(json.routed).toBe(2);
    expect(json.open).toEqual([]);
    expect(
      await Bun.file(join(project.dir, ".fabdesk/runs", json.runId, "frames.jsonl")).exists(),
    ).toBe(true);
    const frames = (
      await Bun.file(join(project.dir, ".fabdesk/runs", json.runId, "frames.jsonl")).text()
    )
      .trim()
      .split("\n");
    // meta + pass-start + two connection frames (the mock reports routed 0, 1, 2)
    expect(
      frames.map(
        (l) =>
          (JSON.parse(l) as { kind: string; event?: { kind: string } }).event?.kind ??
          (JSON.parse(l) as { kind: string }).kind,
      ),
    ).toEqual(["meta", "pass-start", "connection", "connection"]);
    expect(services.events.map((e) => e.topic)).toEqual([
      "route.meta",
      "route.frame",
      "route.frame",
      "route.frame",
      "route.done",
    ]);
    const status = await call("route_status");
    expect(status.text).toContain("done");
    const q = await call("circuit_query", { select: "components" });
    expect(q.text).toContain("R1");
    const errs = await call("circuit_read_errors");
    expect(errs.text).toContain("ok");
    // Broken build
    await writeFile(join(project.dir, "circuit.netlist.json"), "BROKEN");
    const bad = await call("circuit_build");
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("BROKEN marker");
    await call("circuit_build").catch(() => {});
    await writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb)");
    const svg = await call("render_pcb_svg");
    expect(svg.images?.[0]?.mime).toBe("image/svg+xml");
    const drc = await call("verify_drc");
    expect(drc.isError).toBeFalsy();
    await expect(call("render_schematic_svg")).rejects.toThrow(/board.kicad_sch not found/);
  });

  test("route_run reports open connections as an error and keeps text, json and status in step", async () => {
    const reg = createRegistry();
    const project = await tempProject("open");
    const base = mockServices([project]);
    const services = mockServices([project], {
      design: {
        ...base.design,
        route: async (dir, opts, hooks) => {
          const summary = await base.design.route(dir, opts, hooks);
          return {
            ...summary,
            routed: 1,
            total: 3,
            vias: 4,
            tracks: 7,
            unrouted: [
              { net: "N2", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
              { net: "N3", from: { x: 0, y: 0 }, to: { x: 2, y: 2 } },
            ],
          };
        },
      },
    });
    const factory = contextFactory(services, project);
    const call = (name: string, args: Record<string, unknown> = {}) =>
      reg.invoke(name, args, (ref) =>
        factory({
          def: reg.get(name)!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      );
    await call("circuit_build");
    const route = await call("route_run", { timeoutMs: 5000 });
    expect(route.isError).toBe(true);
    expect(route.text).toContain("1/3 connections routed, 4 vias, 7 tracks");
    expect(route.text).toContain("Open nets: N2, N3");
    const json = route.json as {
      routed: number;
      open: string[];
      stats: { vias: number; segments: number };
    };
    expect(json.routed).toBe(1);
    expect(json.open).toEqual(["N2", "N3"]);
    expect(json.stats.vias).toBe(4);
    const status = await call("route_status");
    expect(status.text).toContain("done — 2 open, 4 vias, 7 tracks");
    const done = services.events.find((e) => e.topic === "route.done");
    if (done?.topic !== "route.done") throw new Error("no route.done event");
    expect(done.result.open).toEqual(["N2", "N3"]);
  });

  test("verify_gate baselines warnings", async () => {
    const reg = createRegistry();
    const project = await tempProject();
    const services = mockServices([project]);
    const factory = contextFactory(services, project);
    await mkdir(join(project.dir, "reports"), { recursive: true });
    await writeFile(
      join(project.dir, "reports/drc.json"),
      JSON.stringify({
        violations: [
          {
            severity: "warning",
            rule: "silk_overlap",
            description: "Silkscreen overlap",
            items: [],
            signature: "silk_overlap:",
          },
        ],
        unconnected: [],
        schematicParity: [],
        counts: { errors: 0, warnings: 1, unconnected: 0 },
      }),
    );
    const call = (args: Record<string, unknown>) =>
      reg.invoke("verify_gate", args, (ref) =>
        factory({
          def: reg.get("verify_gate")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      );
    const fail = await call({});
    expect(fail.isError).toBe(true);
    const pass = await call({ acceptWarnings: true });
    expect(pass.isError).toBeFalsy();
    expect(project.manifest().allowedDrcWarnings).toEqual(["silk_overlap:"]);
  });
});

describe("path jail", () => {
  test("rejects escapes and symlinks", async () => {
    const project = await tempProject("jail");
    await mkdir(join(project.dir, "sub"), { recursive: true });
    const outside = join(project.dir, "..", "outside.txt");
    await writeFile(outside, "secret");
    await symlink(outside, join(project.dir, "sub", "link"));
    expect(await jailPath(project.dir, "circuit.tsx")).toBe(join(project.dir, "circuit.tsx"));
    expect(await jailPath(project.dir, "sub/new/file.txt")).toBe(
      join(project.dir, "sub/new/file.txt"),
    );
    await expect(jailPath(project.dir, "../outside.txt")).rejects.toThrow(/escapes/);
    await expect(jailPath(project.dir, "sub/../../outside.txt")).rejects.toThrow(/escapes/);
    await expect(jailPath(project.dir, "/etc/passwd")).rejects.toThrow(/escapes/);
    await expect(jailPath(project.dir, "sub/link")).rejects.toThrow(/symlink/);
    await expect(jailPath(project.dir, "sub/link/deeper")).rejects.toThrow(/symlink/);
    await expect(jailPath(project.dir, "")).rejects.toThrow();
  });

  test("project_write_file/read_file round trip and manifest protection", async () => {
    const reg = createRegistry();
    const project = await tempProject("rw");
    const services = mockServices([project]);
    const factory = contextFactory(services, project);
    const call = (name: string, args: Record<string, unknown>) =>
      reg.invoke(name, args, (ref) =>
        factory({
          def: reg.get(name)!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      );
    await call("project_write_file", { path: "circuit.tsx", content: "export default () => null" });
    const r = await call("project_read_file", { path: "circuit.tsx" });
    expect(r.text).toBe("export default () => null");
    await expect(
      call("project_write_file", { path: "fabdesk.json", content: "{}" }),
    ).rejects.toThrow(/project_set_board/);
    await expect(call("project_write_file", { path: "../x", content: "" })).rejects.toThrow(
      /escapes/,
    );
    const board = await call("project_set_board", { layers: 4, widthMm: 30, heightMm: 20 });
    expect(board.text).toContain("4 layers");
  });
});

describe("agent docs", () => {
  test("markdown lists every tool", () => {
    const reg = createRegistry();
    const md = toolsMarkdown(reg);
    for (const t of reg.list()) expect(md).toContain(`\`${t.name}\``);
    expect(md).toContain("### core");
    expect(md).toContain("load_toolset");
    expect(md).toContain(z.string().constructor.name.length > 0 ? "|" : "");
  });
});

test("RouteProgressFrames turns phase/percent-only progress into attempt frames, once per change", async () => {
  const { RouteProgressFrames } = await import("../src/tools/route");
  const seen: string[] = [];
  const sink = {
    onMessage: (m: { event?: { kind: string; status?: string } }) =>
      seen.push(`${m.event?.kind}:${m.event?.status ?? ""}`),
  };
  const frames = new RouteProgressFrames("run_x", Date.now(), sink as never);
  frames.onProgress({ state: "routing", log: [], phase: "capacity", percent: 10 });
  frames.onProgress({ state: "routing", log: [], phase: "capacity", percent: 10 });
  frames.onProgress({ state: "routing", log: [], phase: "capacity", percent: 40 });
  frames.onProgress({ state: "routing", log: [], phase: "trace", percent: 0 });
  expect(seen).toEqual(["attempt:capacity · 10%", "attempt:capacity · 40%", "attempt:trace · 0%"]);
});

test("circuit_place moves footprints through the design service", async () => {
  const reg = createRegistry();
  const project = await tempProject();
  const services = mockServices([project]);
  const ctx = contextFactory(services, null);
  const out = await reg.invoke(
    "circuit_place",
    { project: project.id, placements: [{ ref: "J2", x: 5, y: 6, rotation: 90 }] },
    (ref) =>
      ctx({
        def: reg.get("circuit_place")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
  );
  expect(out.isError).toBe(false);
  expect(out.text).toContain("J2 → (5, 6) mm, 90°");
});
