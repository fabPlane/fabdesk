import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { ToolError, createRegistry, defineTool, jailPath, toCallToolResult, toolsMarkdown } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

describe("registry", () => {
  test("v1 tool set and naming", () => {
    const reg = createRegistry();
    const names = reg.list().map((t) => t.name);
    expect(names).toEqual([
      "load_toolset", "pcb_environment", "project_status", "circuit_build", "circuit_read_errors", "route_run", "verify_drc", "render_board",
      "project_read_file", "project_write_file", "project_list_sketches", "project_set_board", "project_import_kicad",
      "circuit_query", "circuit_search_parts", "circuit_describe_part", "circuit_check_part_compatibility",
      "design_inspect",
      "native_edit_transaction",
      "native_edit_rollback",
      "schematic_inspect",
      "schematic_edit",
      "schematic_review",
      "pcb_update_from_schematic",
      "pcb_define_outline",
      "pcb_place",
      "route_status", "route_cancel", "route_unroute", "route_scope",
      "kicad_stats",
      "verify_erc",
      "verify_gate",
      "verify_viagrid",
      "release_build",
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
    expect(() => defineTool({ name: "bad.name", toolset: "core", title: "", description: "", inputSchema: {}, annotations: {}, handler: async () => ({}) })).toThrow();
  });

  test("native schematic edit, inspection and forward annotation", async () => {
    const reg = createRegistry();
    const project = await tempProject("native-schematic");
    const base = mockServices([project]);
    const edits: unknown[] = [];
    const services = mockServices([project], {
      design: {
        ...base.design,
        schematicInspect: async () => ({
          revision: 4,
          symbols: [
            {
              id: "sym-r1",
              reference: "R1",
              value: "1k",
              footprint: "Resistor_SMD:R_0603_1608Metric",
              libId: "Device:R",
              position: { x: 30.48, y: 25.4 },
              rotation: 0,
              mirrorX: false,
              mirrorY: false,
              pins: [{ number: "1", name: "~", position: { x: 25.4, y: 25.4 } }],
            },
          ],
          wires: [],
          localLabels: [],
          globalLabels: [],
          junctions: [],
          noConnects: [],
          texts: [],
          nets: [{ name: "VBUS", itemCount: 2 }],
          erc: { errors: 0, warnings: 1 },
        }),
        schematicEdit: async (_dir, edit) => {
          edits.push(edit);
          return {
            created: { symbols: edit.symbols?.length ?? 0, wires: 0, localLabels: 0, globalLabels: 0, junctions: 0, noConnects: 0, texts: 0 },
            updated: { symbols: edit.symbolUpdates?.length ?? 0 },
            deleted: 0,
            saved: true,
            revision: 5,
          };
        },
        syncSchematicToPcb: async (_dir, dryRun) => ({
          ok: true,
          dryRun,
          erc: { errors: 0, warnings: 1 },
          update: { errors: 0, warnings: 0, newFootprints: 1, report: "Add R1" },
          ...(dryRun ? {} : { parity: 0 }),
          saved: !dryRun,
        }),
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

    const edit = await call("schematic_edit", {
      symbols: [
        {
          libId: "Device:R",
          reference: "R1",
          value: "1k",
          footprint: "Resistor_SMD:R_0603_1608Metric",
          position: { x: 30.48, y: 25.4 },
        },
      ],
    });
    expect(edit.text).toContain("created 1 symbols");
    expect(edits).toHaveLength(1);
    const inspect = await call("schematic_inspect");
    expect(inspect.text).toContain("Native schematic revision 4");
    expect(inspect.text).toContain("Device:R");
    const review = await call("schematic_review");
    expect(review.text).toContain("Schematic review at revision 4");
    expect(await Bun.file(join(project.dir, "reports/schematic-review.json")).exists()).toBe(true);
    const preview = await call("pcb_update_from_schematic");
    expect(preview.text).toContain("Preview: OK");
    expect(preview.text).toContain("Preview made no PCB changes");
    const applied = await call("pcb_update_from_schematic", { apply: true });
    expect(applied.text).toContain("Native schematic and PCB saved");
    expect(await Bun.file(join(project.dir, "reports/schematic-sync.json")).exists()).toBe(true);
  });

  test("schematic render returns revision-bound PNG pixels to an MCP client", async () => {
    const reg = createRegistry();
    const project = await tempProject("schematic-pixels");
    const schematic = join(project.dir, "board.kicad_sch");
    await writeFile(schematic, "(kicad_sch (version 20260831))\n");
    const base = mockServices([project]);
    const services = mockServices([project], {
      kicad: {
        ...base.kicad,
        exportSchematicSvg: async (_cli, { outDir }) => {
          await mkdir(outDir, { recursive: true });
          const path = join(outDir, "board.svg");
          await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="white"/><text x="2" y="12">R1</text></svg>');
          return { paths: [path] };
        },
      },
    });
    const output = await reg.invoke("render_schematic_svg", {}, (ref) =>
      contextFactory(services, project)({
        def: reg.get("render_schematic_svg")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
    );
    const call = await toCallToolResult(output);
    const block = call.content.find((part) => part.type === "image");
    expect(block?.type).toBe("image");
    if (block?.type !== "image") throw new Error("missing image block");
    expect(block.mimeType).toBe("image/png");
    expect([...Buffer.from(block.data, "base64").subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const json = output.json as { schematicRevision: { sha256: string }; images: Array<{ schematicRevision: string; width: number; height: number }> };
    expect(json.images[0]!.schematicRevision).toBe(json.schematicRevision.sha256);
    expect(json.images[0]!.width).toBeGreaterThan(0);
    expect(json.images[0]!.height).toBeGreaterThan(0);
  });

  test("revision-bound schematic pixels remain agent-viewable above the generic inline limit", async () => {
    const project = await tempProject("large-schematic-pixels");
    const path = join(project.dir, "large.png");
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await Bun.write(path, bytes);
    const result = await toCallToolResult({ text: "rendered", images: [{ path, mime: "image/png", requiredInline: true }] });
    expect(result.content.map((block) => block.type)).toEqual(["text", "image"]);
  });

  test("schematic render rejects a source revision that changes during export", async () => {
    const reg = createRegistry();
    const project = await tempProject("schematic-stale");
    const schematic = join(project.dir, "board.kicad_sch");
    await writeFile(schematic, "before");
    const base = mockServices([project]);
    const services = mockServices([project], {
      kicad: {
        ...base.kicad,
        exportSchematicSvg: async (_cli, { outDir }) => {
          await mkdir(outDir, { recursive: true });
          const path = join(outDir, "board.svg");
          await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"/>');
          await writeFile(schematic, "after");
          return { paths: [path] };
        },
      },
    });
    await expect(
      reg.invoke("render_schematic_svg", {}, (ref) =>
        contextFactory(services, project)({
          def: reg.get("render_schematic_svg")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      ),
    ).rejects.toThrow(/schematic changed during rendering/);
  });

  test("revision-bound native inspection returns hashes, runtime, geometry and live checks", async () => {
    const reg = createRegistry();
    const project = await tempProject("revision-inspection");
    await writeFile(join(project.dir, "board.kicad_sch"), "(kicad_sch (version 20260831))\n");
    await writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb (version 20260831))\n");
    const services = mockServices([project]);
    const factory = contextFactory(services, project);
    const inspected = await reg.invoke("design_inspect", {}, (ref) =>
      factory({
        def: reg.get("design_inspect")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
    );
    const json = inspected.json as Record<string, any>;
    expect(json.contract).toEqual({ name: "fabdesk.native-inspection", version: "1.0.0" });
    expect(json.runtime.runtimeId).toBe("test-runtime");
    expect(json.revisions.schematic.sha256).toHaveLength(64);
    expect(json.revisions.pcb.sha256).toHaveLength(64);
    expect(json.checks.drc.schematicParityChecked).toBe(true);
    expect(json.pcb.remainingConnections).toHaveLength(1);
    expect(await Bun.file(join(project.dir, "reports/native-inspection.json")).exists()).toBe(true);
  });

  test("verify_drc binds actionable violations to the exact PCB geometry", async () => {
    const reg = createRegistry();
    const project = await tempProject("actionable-drc");
    await writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb (version 20260831))\n");
    const base = mockServices([project]);
    const services = mockServices([project], {
      design: {
        ...base.design,
        query: async (_dir, select) =>
          select === "tracks"
            ? [{
                id: "{TRACK-1}",
                kind: "Track",
                net: "GND",
                layer: "F.Cu",
                start: "1,2",
                end: "3,4",
                width: 0.25,
                clearance: 0.2,
              }]
            : [],
      },
      kicad: {
        ...base.kicad,
        runDrc: async () => ({
          violations: [{
            rule: "clearance",
            severity: "error",
            description: "Copper clearance violation",
            items: [{ description: "Track", uuid: "track-1", pos: { x: 2, y: 3 } }],
            coordinates: [{ x: 2, y: 3 }],
            layers: [],
            nets: [],
            objectIds: ["track-1"],
            affectedGeometry: [],
            signature: "clearance:Track",
          }],
          unconnected: [],
          schematicParity: [],
          counts: { errors: 1, warnings: 0, unconnected: 0 },
        }),
      },
    });
    const factory = contextFactory(services, project);
    const result = await reg.invoke("verify_drc", {}, (ref) =>
      factory({
        def: reg.get("verify_drc")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
    );
    const json = result.json as any;
    expect(json.pcbRevision.sha256).toHaveLength(64);
    expect(json.violations[0]).toMatchObject({
      rule: "clearance",
      severity: "error",
      coordinates: [{ x: 2, y: 3 }, { x: 1, y: 2 }, { x: 3, y: 4 }],
      layers: ["F.Cu"],
      nets: ["GND"],
      objectIds: ["track-1"],
      affectedGeometry: [{
        objectType: "tracks",
        id: "{TRACK-1}",
        net: "GND",
        layer: "F.Cu",
        width: 0.25,
        clearance: 0.2,
      }],
    });
    const saved = await Bun.file(join(project.dir, "reports/drc.json")).json();
    expect(saved.pcbRevision).toEqual(json.pcbRevision);
    expect(saved.violations[0].affectedGeometry[0].id).toBe("{TRACK-1}");
  });

  test("verify_drc rejects a PCB revision change during the check", async () => {
    const reg = createRegistry();
    const project = await tempProject("stale-drc");
    const board = join(project.dir, "board.kicad_pcb");
    await writeFile(board, "before");
    const base = mockServices([project]);
    const services = mockServices([project], {
      kicad: {
        ...base.kicad,
        runDrc: async () => {
          await Bun.write(board, "after");
          return { violations: [], unconnected: [], schematicParity: [], counts: { errors: 0, warnings: 0, unconnected: 0 } };
        },
      },
    });
    const factory = contextFactory(services, project);
    await expect(reg.invoke("verify_drc", {}, (ref) =>
      factory({
        def: reg.get("verify_drc")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
    )).rejects.toThrow(/changed while DRC was running/);
    expect(await Bun.file(join(project.dir, "reports/drc.json")).exists()).toBe(false);
  });

  test("atomic native edit previews, restores rejected writes, and rolls back accepted revisions", async () => {
    const reg = createRegistry();
    const project = await tempProject("atomic-native-edit");
    await writeFile(join(project.dir, "board.kicad_sch"), "before-sch");
    await writeFile(join(project.dir, "board.kicad_pcb"), "before-pcb");
    await writeFile(join(project.dir, "board.kicad_pro"), "before-pro");
    const base = mockServices([project]);
    const services = mockServices([project], {
      design: {
        ...base.design,
        schematicEdit: async () => {
          await Bun.write(join(project.dir, "board.kicad_sch"), "after-sch");
          return { created: { symbols: 0, wires: 0, localLabels: 0, globalLabels: 0, junctions: 0, noConnects: 0, texts: 1 }, updated: { symbols: 0 }, deleted: 0, saved: true, revision: 2 };
        },
      },
    });
    const factory = contextFactory(services, project);
    const call = (args: Record<string, unknown>) => reg.invoke("native_edit_transaction", args, (ref) => factory({ def: reg.get("native_edit_transaction")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
    const preview = await call({ schematic: { texts: [{ text: "note", position: { x: 10, y: 10 } }] } });
    expect((preview.json as any).status).toBe("preview");
    expect(await Bun.file(join(project.dir, "board.kicad_sch")).text()).toBe("before-sch");
    const accepted = await call({ mode: "apply", schematic: { texts: [{ text: "note", position: { x: 10, y: 10 } }] } });
    const transactionId = (accepted.json as any).transactionId;
    expect(await Bun.file(join(project.dir, "board.kicad_sch")).text()).toBe("after-sch");
    const rolledBack = await reg.invoke("native_edit_rollback", { transactionId }, (ref) => factory({ def: reg.get("native_edit_rollback")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
    expect((rolledBack.json as any).status).toBe("rolled-back");
    expect(await Bun.file(join(project.dir, "board.kicad_sch")).text()).toBe("before-sch");
  });

  test("atomic PCB geometry edits are previewable, revision-guarded, local, inspectable, and reversible", async () => {
    const reg = createRegistry();
    const project = await tempProject("atomic-pcb-geometry");
    const board = join(project.dir, "board.kicad_pcb");
    await writeFile(board, "unrelated-copper\n");
    const initialRevision = createHash("sha256").update("unrelated-copper\n").digest("hex");
    const base = mockServices([project]);
    let editCalls = 0;
    const services = mockServices([project], {
      design: {
        ...base.design,
        editBoardGeometry: async (_dir, edit) => {
          editCalls++;
          expect(edit.tracks).toHaveLength(1);
          await Bun.write(board, `${await Bun.file(board).text()}new-track\n`);
          return { created: { tracks: 1, vias: 0, zones: 0, keepouts: 0, texts: 0, graphics: 0 }, createdIds: ["track-new"], deletedIds: [], revision: 5, saved: true };
        },
        inspectBoardGeometry: async () => ({
          revisionStart: 5,
          revisionEnd: 5,
          revisionStable: true,
          pads: [{ id: "pad-1", reference: "U1", number: "1", position: { x: 11, y: 12 }, layers: [0], net: "GND", clearance: 0.2 }],
          tracks: [{ id: "track-new", start: { x: 11, y: 12 }, end: { x: 15, y: 12 }, layer: 0, net: "GND", width: 0.25 }],
          vias: [], zones: [], texts: [], graphics: [],
          nets: [{ name: "GND", code: 1, clearance: 0.2 }],
          rules: { minimums: { minClearance: 0.2 } },
        }),
      },
    });
    const factory = contextFactory(services, project);
    const call = (args: Record<string, unknown>) => reg.invoke("native_edit_transaction", args, (ref) => factory({ def: reg.get("native_edit_transaction")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
    const geometry = { tracks: [{ start: { x: 11, y: 12 }, end: { x: 15, y: 12 }, width: 0.25, layer: 0, net: "GND" }] };

    const preview = await call({ geometry, expectedPcbRevision: initialRevision });
    expect((preview.json as any).plan.geometry.tracks).toBe(1);
    expect(editCalls).toBe(0);
    expect(await Bun.file(board).text()).toBe("unrelated-copper\n");
    await expect(call({ mode: "apply", geometry, expectedPcbRevision: "0".repeat(64) })).rejects.toThrow(/stale PCB revision/);

    const accepted = await call({ mode: "apply", geometry, expectedPcbRevision: initialRevision });
    expect(await Bun.file(board).text()).toBe("unrelated-copper\nnew-track\n");
    expect((accepted.json as any).pcbGeometry).toMatchObject({
      revisionStable: true,
      pads: [{ position: { x: 11, y: 12 }, net: "GND" }],
      tracks: [{ id: "track-new", layer: 0, net: "GND" }],
      rules: { minimums: { minClearance: 0.2 } },
    });
    await reg.invoke("native_edit_rollback", { transactionId: (accepted.json as any).transactionId }, (ref) => factory({ def: reg.get("native_edit_rollback")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
    expect(await Bun.file(board).text()).toBe("unrelated-copper\n");
  });

  test("complete release is revision-bound and fails closed on missing outputs", async () => {
    const reg = createRegistry();
    const project = await tempProject("release");
    for (const [name, body] of [["board.kicad_sch", "sch"], ["board.kicad_pcb", "pcb"], ["board.kicad_pro", "pro"]]) await writeFile(join(project.dir, name), body);
    const base = mockServices([project]);
    const put = async (path: string, body = "output") => { await mkdir(join(path, ".."), { recursive: true }).catch(() => {}); await Bun.write(path, body); };
    const services = mockServices([project], {
      kicad: {
        ...base.kicad,
        renderPng: async (_cli, { output }) => put(output, "png"),
        exportSchematicSvg: async (_cli, { outDir }) => { await mkdir(outDir, { recursive: true }); const path = join(outDir, "board.svg"); await put(path, "svg"); return { paths: [path] }; },
        exportSchematicPdf: async (_cli, { output }) => { await put(output, "pdf"); return { paths: [output] }; },
        exportPcbSvg: async (_cli, { output }) => { await put(output, "svg"); return { paths: [output] }; },
        exportGerbers: async (_cli, { outDir }) => { const gbr = join(outDir, "board-F_Cu.gbr"), job = join(outDir, "board-job.gbrjob"); await put(gbr); await put(job); return { paths: [gbr, job] }; },
        exportDrill: async (_cli, { outDir }) => { const path = join(outDir, "board.drl"); await put(path); return { paths: [path] }; },
        exportPos: async (_cli, { output }) => { await put(output); return { paths: [output] }; },
        exportBom: async (_cli, { output }) => { await put(output); return { paths: [output] }; },
        exportNetlist: async (_cli, { output }) => { await put(output); return { paths: [output] }; },
      },
    });
    const factory = contextFactory(services, project);
    const release = await reg.invoke("release_build", { buildNotes: "Fit LED with marked cathode.", circuitChecks: [{ kind: "led-current", supplyVolts: 5, forwardVolts: 2, resistanceOhms: 1000, minMa: 2, maxMa: 4 }] }, (ref) => factory({ def: reg.get("release_build")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
    expect(release.isError).toBeFalsy();
    expect((release.json as any).pass).toBe(true);
    expect((release.json as any).revisions.schematic).toHaveLength(64);
    expect((release.json as any).inventory.some((entry: any) => entry.path === "exports/fabrication.zip" && entry.status === "available")).toBe(true);
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
    expect(reg.contract().version).toBe("option-1-mcp/1.0.0");
    expect(reg.contract().sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("agent-facing tool metadata contains capabilities without workflow policy", () => {
    const reg = createRegistry();
    const agentFacing = [
      ...reg.manifest().flatMap((tool) => [tool.title, tool.description, JSON.stringify(tool.inputSchema)]),
      toolsMarkdown(reg),
    ].join("\n");
    expect(agentFacing).not.toMatch(/run [^.\n]* first|use [^.\n]* (?:before|after)|prefer|repeat until|retry|required workflow|must use|should use|stop after|only after|release checklist|stopping policy/i);
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
    const environment = await reg.invoke("pcb_environment", { project: project.id }, (ref) => noProject({ def: reg.get("pcb_environment")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
    expect(environment.text).toContain("/mock/kicad-cli (10.99.0)");
    expect(environment.text).toContain("State visibility:");
    expect(environment.text).not.toContain("deliberately");
    expect(environment.json).toMatchObject({ project: { dir: project.dir }, kicadCli: { path: "/mock/kicad-cli", version: "10.99.0" }, bridge: { url: "http://127.0.0.1:4020", ok: true }, uiConventions: { canonicalFiles: { board: join(project.dir, "board.kicad_pcb") } } });
    expect((out.json as any)._contract).toEqual(reg.contract());
    const symbols = await reg.invoke("circuit_search_parts", { query: "resistor", kind: "symbol" }, (ref) => noProject({ def: reg.get("circuit_search_parts")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
    expect(symbols.text).toContain("Device:R");
    expect(symbols.json).toMatchObject({ kind: "symbol" });
    const part = await reg.invoke(
      "circuit_describe_part",
      { kind: "symbol", libId: "Device:R" },
      (ref) =>
        noProject({
          def: reg.get("circuit_describe_part")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
    );
    expect(part.text).toContain("number");
    expect(part.text).toContain("PT_PASSIVE");
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
    const base = mockServices([project]);
    let statsCalls = 0;
    const services = mockServices([project], {
      kicad: {
        ...base.kicad,
        boardStats: async (_cli, { scratchFile }) => {
          statsCalls++;
          await Bun.write(scratchFile, JSON.stringify({ board: { width: "20 mm" } }));
          return { width: 20 };
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
    const build = await call("circuit_build");
    expect(build.isError).toBeFalsy();
    expect(await Bun.file(join(project.dir, "board.kicad_pcb")).exists()).toBe(true);
    await mkdir(join(project.dir, "reports"), { recursive: true });
    await writeFile(join(project.dir, "reports/stats.json"), '{"stale":true}');
    const route = await call("route_run", { timeoutMs: 5000 });
    expect(route.isError).toBeFalsy();
    const json = route.json as { runId: string; routed: number; total: number; open: string[] };
    expect(json.routed).toBe(2);
    expect(json.open).toEqual([]);
    expect(statsCalls).toBe(1);
    expect(await Bun.file(join(project.dir, "reports/stats.json")).json()).toEqual({
      board: { width: "20 mm" },
    });
    expect(
      await Bun.file(join(project.dir, ".fabdesk/runs", json.runId, "frames.jsonl")).exists(),
    ).toBe(true);
    const frames = (
      await Bun.file(join(project.dir, ".fabdesk/runs", json.runId, "frames.jsonl")).text()
    )
      .trim()
      .split("\n");
    // meta + static pads + progress + a final frame carrying the real routed copper.
    expect(
      frames.map(
        (l) =>
          (JSON.parse(l) as { kind: string; event?: { kind: string } }).event?.kind ??
          (JSON.parse(l) as { kind: string }).kind,
      ),
    ).toEqual(["meta", "static", "pass-start", "connection", "connection", "done"]);
    expect((JSON.parse(frames.at(-1)!) as { shapes: unknown[] }).shapes).toHaveLength(1);
    expect(services.events.map((e) => e.topic)).toEqual([
      "route.meta",
      "route.static",
      "route.frame",
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
    expect((json as any).state).toBe("partial");
    expect(json.open).toEqual(["N2", "N3"]);
    expect(json.stats.vias).toBe(4);
    const status = await call("route_status");
    expect(status.text).toContain("done — 2 open, 4 vias, 7 tracks");
    const done = services.events.find((e) => e.topic === "route.done");
    if (done?.topic !== "route.done") throw new Error("no route.done event");
    expect(done.result.open).toEqual(["N2", "N3"]);
  });

  test("diagnostic routing distinguishes blocked, unavailable and non-mutating no-progress", async () => {
    const reg = createRegistry();
    const project = await tempProject("diagnostic-route");
    await writeFile(join(project.dir, "board.kicad_pcb"), "canonical-board");
    const base = mockServices([project]);
    const services = mockServices([project], {
      design: {
        ...base.design,
        route: async () => {
          await Bun.write(join(project.dir, "board.kicad_pcb"), "router-touched-board");
          return { tracks: 0, vias: 0, claimedVias: 0, routed: 0, total: 1, trackLengthNm: 0, elapsedMs: 1, wallMs: 1, timedOut: false, message: "blocked by edge clearance", unrouted: [{ net: "N1", from: { x: 0, y: 0 }, to: { x: 5, y: 5 } }], geometry: [], log: ["endpoint blocked by board edge"] };
        },
      },
    });
    const factory = contextFactory(services, project);
    const call = (args: Record<string, unknown>) => reg.invoke("route_run", args, (ref) => factory({ def: reg.get("route_run")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
    const blocked = await call({ timeoutMs: 5000, targets: [{ net: "NOT_A_NET" }] });
    expect((blocked.json as any).state).toBe("blocked");
    const unavailable = await call({ timeoutMs: 5000, router: "freerouting" });
    expect((unavailable.json as any).state).toBe("unavailable");
    const noProgress = await call({ timeoutMs: 5000, targets: [{ net: "N1" }], rules: { widthMm: 0.25, clearanceMm: 0.2 } });
    expect((noProgress.json as any).state).toBe("no-progress");
    expect((noProgress.json as any).obstacles[0]).toContain("blocked");
    expect(await Bun.file(join(project.dir, "board.kicad_pcb")).text()).toBe("canonical-board");
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
        schematicParityChecked: true,
        counts: { errors: 0, warnings: 1, unconnected: 0 },
      }),
    );
    await writeFile(
      join(project.dir, "reports/erc.json"),
      JSON.stringify({ violations: [], counts: { errors: 0, warnings: 0 } }),
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
    expect(md).toContain("Tools are namespaced");
    expect(md).not.toContain("workflow");
    expect(md).toContain(z.string().constructor.name.length > 0 ? "|" : "");
  });
});
