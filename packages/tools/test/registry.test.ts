import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import {
  ToolError,
  createRegistry,
  defineTool,
  inspectDesignRuleFloors,
  inspectPcbPresentation,
  isLibraryMismatch,
  jailPath,
  toCallToolResult,
  toolsMarkdown,
} from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

describe("registry", () => {
  test("release recognizes KiCad library mismatch rules and descriptions", () => {
    expect(
      isLibraryMismatch({
        rule: "lib_footprint_mismatch",
        description: "Footprint R1 does not match copy in library",
      }),
    ).toBe(true);
    expect(
      isLibraryMismatch({
        rule: "warning",
        description: "Symbol does not match the copy in the library",
      }),
    ).toBe(true);
    expect(
      isLibraryMismatch({ rule: "silk_overlap", description: "Reference text overlaps a pad" }),
    ).toBe(false);
  });

  test("release detects relaxed design-rule floors", () => {
    const safe = inspectDesignRuleFloors(
      JSON.stringify({
        board: {
          design_settings: {
            rules: {
              min_hole_clearance: 0.25,
              min_copper_edge_clearance: 0.5,
              min_track_width: 0.2,
            },
          },
        },
      }),
    );
    expect(safe.status).toBe("pass");
    const relaxed = inspectDesignRuleFloors(
      JSON.stringify({
        board: {
          design_settings: {
            rules: {
              min_hole_clearance: 0.18,
              min_copper_edge_clearance: 0.5,
              min_track_width: 0.2,
            },
          },
        },
      }),
    );
    expect(relaxed.status).toBe("fail");
    expect(relaxed.violations).toEqual([
      "min_hole_clearance was relaxed to 0.18 mm (release floor 0.25 mm)",
    ]);
  });

  test("release detects hidden PCB references", () => {
    const board = `(kicad_pcb ${[1, 2, 3, 4, 5].map((index) => `(footprint "R${index}" (property "Reference" "R${index}" (hide yes)))`).join(" ")})`;
    expect(inspectPcbPresentation(board)).toMatchObject({
      status: "fail",
      counts: { footprints: 5, referenceFields: 5, visibleReferences: 0, hiddenReferences: 5 },
    });
  });

  test("native part search guidance does not steer agents to the legacy compiler", () => {
    const tool = createRegistry().get("circuit_search_parts");
    expect(tool?.description).toContain("native schematic and PCB operations");
    expect(tool?.description).not.toContain("circuit_build");
    expect(tool?.description).not.toContain("libSource");
  });

  test("v1 tool set and naming", () => {
    const reg = createRegistry();
    const names = reg.list().map((t) => t.name);
    expect(names).toEqual([
      "load_toolset",
      "pcb_environment",
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
      "circuit_describe_part",
      "circuit_check_part_compatibility",
      "design_inspect",
      "pcb_inspect",
      "native_edit_transaction",
      "native_edit_rollback",
      "pcb_edit_copper",
      "pcb_edit_graphics",
      "schematic_inspect",
      "schematic_edit",
      "schematic_review",
      "pcb_update_from_schematic",
      "pcb_define_outline",
      "pcb_place",
      "route_status",
      "route_cancel",
      "route_unroute",
      "route_scope",
      "kicad_stats",
      "verify_erc",
      "verify_gate",
      "verify_viagrid",
      "release_build",
      "render_schematic_svg",
      "render_pcb_svg",
      "render_view",
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
    expect(reg.byToolset("core").length).toBe(9);
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

  test("bounded PCB inspection filters by region and returns revision-bound compact rows", async () => {
    const reg = createRegistry();
    const project = await tempProject("spatial-inspection");
    await writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb (version 20260831))\n");
    const services = mockServices([project]);
    const ctx = contextFactory(services, project);
    const output = await reg.invoke(
      "pcb_inspect",
      {
        kinds: ["components", "pads", "unrouted"],
        region: { minX: 0, minY: 2, maxX: 2, maxY: 4 },
        limitPerKind: 10,
      },
      (ref) =>
        ctx({
          def: reg.get("pcb_inspect")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
    );
    const json = output.json as {
      revision: string;
      coordinateSystem: { units: string };
      results: Record<string, { total: number }>;
    };
    expect(json.revision).toHaveLength(64);
    expect(json.coordinateSystem.units).toBe("mm");
    expect(json.results["components"]?.total).toBe(1);
    expect(json.results["pads"]?.total).toBe(1);
    expect(json.results["unrouted"]?.total).toBe(1);
    expect(JSON.stringify(output).length).toBeLessThan(5000);
  });

  test("PCB inspection is empty before the board exists", async () => {
    const reg = createRegistry();
    const project = await tempProject("empty-spatial-inspection");
    const base = mockServices([project]);
    let queries = 0;
    const services = mockServices([project], {
      design: {
        ...base.design,
        query: async () => {
          queries++;
          return [];
        },
      },
    });
    const ctx = contextFactory(services, project);
    const output = await reg.invoke("pcb_inspect", { kinds: ["components", "tracks"] }, (ref) =>
      ctx({
        def: reg.get("pcb_inspect")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
    );
    expect(output.text).toContain("not created yet");
    expect(output.json).toMatchObject({
      revision: null,
      bounds: null,
      results: { components: { total: 0 }, tracks: { total: 0 } },
    });
    expect(queries).toBe(0);
  });

  test("focused PCB render crops in board coordinates and highlights inspected items", async () => {
    const reg = createRegistry();
    const project = await tempProject("focused-pcb-view");
    await writeFile(join(project.dir, "board.kicad_pcb"), "(kicad_pcb (version 20260831))\n");
    const base = mockServices([project]);
    const services = mockServices([project], {
      kicad: {
        ...base.kicad,
        exportPcbSvg: async (_cli, { output }) => {
          await mkdir(join(project.dir, "renders"), { recursive: true });
          await writeFile(
            output,
            '<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20"><rect width="20" height="20" fill="white"/></svg>',
          );
          return { paths: [output] };
        },
      },
    });
    const output = await reg.invoke(
      "render_view",
      {
        document: "pcb",
        region: { minX: 0, minY: 2, maxX: 2, maxY: 4 },
        highlightReferences: ["R1"],
        highlightNets: ["N1"],
      },
      (ref) =>
        contextFactory(
          services,
          project,
        )({
          def: reg.get("render_view")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
    );
    const json = output.json as {
      pcbRevision: { sha256: string };
      highlighted: number;
      region: Record<string, number>;
      pngPath: string;
    };
    expect(json.pcbRevision.sha256).toHaveLength(64);
    expect(json.highlighted).toBe(2);
    expect(json.region).toEqual({ minX: 0, minY: 2, maxX: 2, maxY: 4 });
    expect(await Bun.file(json.pngPath).exists()).toBe(true);
    const svg = await Bun.file(join(project.dir, "renders/pcb-view.svg")).text();
    expect(svg).toContain('viewBox="0 2 2 2"');
    expect(svg).toContain('id="fabdesk-highlights"');
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
            created: {
              symbols: edit.symbols?.length ?? 0,
              wires: 0,
              localLabels: 0,
              globalLabels: 0,
              junctions: 0,
              noConnects: 0,
              texts: 0,
            },
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
          rotation: 90,
        },
      ],
    });
    expect(edit.text).toContain("created 1 symbols");
    expect(edits).toHaveLength(3);
    expect(edits[0]?.symbols?.[0]).toMatchObject({ reference: "R1", rotation: 0 });
    expect(edits[1]?.symbolUpdates?.[0]).toMatchObject({ reference: "R1", rotation: 90 });
    const powerEdit = await call("schematic_edit", {
      symbols: [
        {
          libId: "power:PWR_FLAG",
          reference: "#FLG01",
          value: "PWR_FLAG",
          position: { x: 20.32, y: 20.32 },
        },
      ],
      connections: [{ name: "VBUS", nodes: [{ reference: "#FLG01", pin: "1" }], label: "global" }],
    });
    expect(powerEdit.text).toContain("created 1 symbols");
    await expect(
      call("schematic_edit", {
        connections: [{ name: "BAD", nodes: [{ reference: "R1", pin: "1" }], label: "none" }],
      }),
    ).rejects.toThrow(/direct wire connections require at least two nodes/);
    const inspect = await call("schematic_inspect");
    expect(inspect.text).toContain("Native schematic revision 4");
    expect(inspect.text).toContain(
      "KiCad IPC session diagnostics (informational; not saved-file ERC)",
    );
    expect(inspect.text).not.toMatch(/(^|\n)ERC:/);
    expect(inspect.text).toContain("Device:R");
    expect((inspect.json as any).contract).toEqual({
      name: "fabdesk.schematic-inspection",
      version: "2.0.0",
    });
    expect((inspect.json as any).symbols).toHaveLength(1);
    expect((inspect.json as any).nets).toBeUndefined();
    expect((inspect.json as any).erc).toBeUndefined();
    expect((inspect.json as any).sessionDiagnostics).toMatchObject({
      source: "kicad-ipc-session",
      authority: "informational-not-saved-file-erc",
      counts: { errors: 0, warnings: 1 },
    });
    const fullInspect = await call("schematic_inspect", { detail: "full" });
    expect((fullInspect.json as any).nets).toHaveLength(1);
    expect((fullInspect.json as any).erc).toBeUndefined();
    const review = await call("schematic_review");
    expect(review.text).toContain("Schematic presentation review at revision 4");
    expect(review.text).not.toContain("ERC");
    expect((review.json as any).erc).toBeUndefined();
    expect((review.json as any).sessionDiagnostics.source).toBe("kicad-ipc-session");
    expect(await Bun.file(join(project.dir, "reports/schematic-review.json")).exists()).toBe(true);
    const preview = await call("pcb_update_from_schematic", { apply: false });
    expect(preview.text).toContain("Preview: OK");
    expect(preview.text).toContain("KiCad IPC session diagnostics");
    expect(preview.text).not.toMatch(/(^|\n)ERC:/);
    expect((preview.json as any).erc).toBeUndefined();
    expect((preview.json as any).sessionDiagnostics.source).toBe("kicad-ipc-session");
    expect(preview.text).toContain("Preview made no PCB changes");
    const applied = await call("pcb_update_from_schematic");
    expect(applied.text).toContain("Native schematic and PCB saved");
    expect(await Bun.file(join(project.dir, "reports/schematic-sync.json")).exists()).toBe(true);
  });

  test("presentation review cannot conflict with saved-file CLI ERC", async () => {
    const reg = createRegistry();
    const project = await tempProject("diagnostic-provenance");
    await writeFile(join(project.dir, "board.kicad_sch"), "(kicad_sch (version 20260831))\n");
    const base = mockServices([project]);
    for (const warnings of [3, 13]) {
      const services = mockServices([project], {
        design: {
          ...base.design,
          schematicInspect: async () => ({
            ...(await base.design.schematicInspect(project.dir)),
            revision: warnings === 3 ? 7 : 10,
            erc: { errors: 0, warnings },
          }),
        },
        kicad: {
          ...base.kicad,
          runErc: async () => ({ violations: [], counts: { errors: 0, warnings: 0 } }),
        },
      });
      const factory = contextFactory(services, project);
      const call = (name: string) =>
        reg.invoke(name, {}, (ref) =>
          factory({
            def: reg.get(name)!,
            projectRef: ref,
            signal: new AbortController().signal,
            progress: () => {},
          }),
        );
      const review = await call("schematic_review");
      const verified = await call("verify_erc");
      expect(review.text).toBe(
        `Schematic presentation review at revision ${warnings === 3 ? 7 : 10}: 0 finding(s).\nNo presentation risks detected by the current checks.`,
      );
      expect((review.json as any).sessionDiagnostics.counts).toEqual({ errors: 0, warnings });
      expect(verified.text).toMatch(
        /^Saved-file ERC measured by packaged kicad-cli 10\.99\.0 for board\.kicad_sch revision [0-9a-f]{64}: 0 errors, 0 warnings$/,
      );
      expect((verified.json as any).measurement).toMatchObject({
        source: "packaged-kicad-cli",
        scope: "saved board.kicad_sch",
        revisionStable: true,
      });
    }
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
          await writeFile(
            path,
            '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="white"/><text x="2" y="12">R1</text></svg>',
          );
          return { paths: [path] };
        },
      },
    });
    const output = await reg.invoke("render_schematic_svg", {}, (ref) =>
      contextFactory(
        services,
        project,
      )({
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
    expect([...Buffer.from(block.data, "base64").subarray(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    const json = output.json as {
      schematicRevision: { sha256: string };
      images: Array<{ schematicRevision: string; width: number; height: number }>;
    };
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
    const result = await toCallToolResult({
      text: "rendered",
      images: [{ path, mime: "image/png", requiredInline: true }],
    });
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
        contextFactory(
          services,
          project,
        )({
          def: reg.get("render_schematic_svg")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      ),
    ).rejects.toThrow(/schematic changed during rendering/);
  });

  test("revision-bound native inspection separates session diagnostics from saved-file checks", async () => {
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
    expect(json.contract).toEqual({ name: "fabdesk.native-inspection", version: "1.1.0" });
    expect(json.runtime.runtimeId).toBe("test-runtime");
    expect(json.revisions.schematic.sha256).toHaveLength(64);
    expect(json.revisions.pcb.sha256).toHaveLength(64);
    expect(json.schematic.erc).toBeUndefined();
    expect(json.schematic.sessionDiagnostics.source).toBe("kicad-ipc-session");
    expect(json.checks.savedFileErc).toMatchObject({
      source: "packaged-kicad-cli",
      scope: "saved board.kicad_sch",
      revision: json.revisions.schematic.sha256,
    });
    expect(json.checks.savedFileDrc.report.schematicParityChecked).toBe(true);
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
            ? [
                {
                  id: "{TRACK-1}",
                  kind: "Track",
                  net: "GND",
                  layer: "F.Cu",
                  start: "1,2",
                  end: "3,4",
                  width: 0.25,
                  clearance: 0.2,
                },
              ]
            : [],
      },
      kicad: {
        ...base.kicad,
        runDrc: async () => ({
          violations: [
            {
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
            },
          ],
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
      coordinates: [
        { x: 2, y: 3 },
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
      layers: ["F.Cu"],
      nets: ["GND"],
      objectIds: ["track-1"],
      affectedGeometry: [
        {
          objectType: "tracks",
          id: "{TRACK-1}",
          net: "GND",
          layer: "F.Cu",
          width: 0.25,
          clearance: 0.2,
        },
      ],
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
          return {
            violations: [],
            unconnected: [],
            schematicParity: [],
            counts: { errors: 0, warnings: 0, unconnected: 0 },
          };
        },
      },
    });
    const factory = contextFactory(services, project);
    await expect(
      reg.invoke("verify_drc", {}, (ref) =>
        factory({
          def: reg.get("verify_drc")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      ),
    ).rejects.toThrow(/changed while DRC was running/);
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
          return {
            created: {
              symbols: 0,
              wires: 0,
              localLabels: 0,
              globalLabels: 0,
              junctions: 0,
              noConnects: 0,
              texts: 1,
            },
            updated: { symbols: 0 },
            deleted: 0,
            saved: true,
            revision: 2,
          };
        },
      },
    });
    const factory = contextFactory(services, project);
    const call = (args: Record<string, unknown>) =>
      reg.invoke("native_edit_transaction", args, (ref) =>
        factory({
          def: reg.get("native_edit_transaction")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      );
    const preview = await call({
      schematic: { texts: [{ text: "note", position: { x: 10, y: 10 } }] },
    });
    expect((preview.json as any).status).toBe("preview");
    expect(await Bun.file(join(project.dir, "board.kicad_sch")).text()).toBe("before-sch");
    const accepted = await call({
      mode: "apply",
      schematic: { texts: [{ text: "note", position: { x: 10, y: 10 } }] },
    });
    const transactionId = (accepted.json as any).transactionId;
    expect(await Bun.file(join(project.dir, "board.kicad_sch")).text()).toBe("after-sch");
    const rolledBack = await reg.invoke("native_edit_rollback", { transactionId }, (ref) =>
      factory({
        def: reg.get("native_edit_rollback")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
    );
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
          expect(edit.tracks?.[0]?.layer).toBe(3);
          await Bun.write(board, `${await Bun.file(board).text()}new-track\n`);
          return {
            created: { tracks: 1, vias: 0, zones: 0, keepouts: 0, texts: 0, graphics: 0 },
            createdIds: ["track-new"],
            deletedIds: [],
            revision: 5,
            saved: true,
          };
        },
        inspectBoardGeometry: async () => ({
          revisionStart: 5,
          revisionEnd: 5,
          revisionStable: true,
          pads: [
            {
              id: "pad-1",
              reference: "U1",
              number: "1",
              position: { x: 11, y: 12 },
              layers: [0],
              net: "GND",
              clearance: 0.2,
            },
          ],
          tracks: [
            {
              id: "track-new",
              start: { x: 11, y: 12 },
              end: { x: 15, y: 12 },
              layer: 0,
              net: "GND",
              width: 0.25,
            },
          ],
          vias: [],
          zones: [],
          texts: [],
          graphics: [],
          nets: [{ name: "GND", code: 1, clearance: 0.2 }],
          rules: { minimums: { minClearance: 0.2 } },
        }),
      },
    });
    const factory = contextFactory(services, project);
    const call = (args: Record<string, unknown>) =>
      reg.invoke("native_edit_transaction", args, (ref) =>
        factory({
          def: reg.get("native_edit_transaction")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      );
    const geometry = {
      tracks: [
        {
          start: { reference: "R1", pad: "1" },
          end: { x: 15, y: 12 },
          width: 0.25,
          layer: "F.Cu",
          net: "GND",
        },
      ],
    };

    const preview = await call({ geometry, expectedPcbRevision: initialRevision });
    expect((preview.json as any).plan.geometry.tracks).toBe(1);
    expect(editCalls).toBe(0);
    expect(await Bun.file(board).text()).toBe("unrelated-copper\n");
    await expect(
      call({ mode: "apply", geometry, expectedPcbRevision: "0".repeat(64) }),
    ).rejects.toThrow(/stale PCB revision/);

    const accepted = await call({ mode: "apply", geometry, expectedPcbRevision: initialRevision });
    expect(await Bun.file(board).text()).toBe("unrelated-copper\nnew-track\n");
    expect((accepted.json as any).changes.geometry).toMatchObject({
      created: { tracks: 1 },
      createdIds: ["track-new"],
      revision: 5,
    });
    expect((accepted.json as any).pcbGeometry).toBeUndefined();
    expect((accepted.json as any).validation).toEqual({ structural: true, designChecksRun: false });
    await reg.invoke(
      "native_edit_rollback",
      { transactionId: (accepted.json as any).transactionId },
      (ref) =>
        factory({
          def: reg.get("native_edit_rollback")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
    );
    expect(await Bun.file(board).text()).toBe("unrelated-copper\n");
  });

  test("broad copper replacement uses a durable candidate and never persists removal alone", async () => {
    const reg = createRegistry();
    const project = await tempProject("atomic-copper-candidate");
    const board = join(project.dir, "board.kicad_pcb");
    await writeFile(board, "existing-route\n");
    const revision = createHash("sha256").update("existing-route\n").digest("hex");
    const candidateFile = "routes/replacement.json";
    await mkdir(join(project.dir, "routes"), { recursive: true });
    await writeFile(
      join(project.dir, candidateFile),
      JSON.stringify({
        tracks: [
          {
            start: { x: 1, y: 2 },
            end: { x: 3, y: 4 },
            width: 0.25,
            layer: "F.Cu",
            net: "GND",
          },
        ],
      }),
    );
    const base = mockServices([project]);
    const order: string[] = [];
    const services = mockServices([project], {
      design: {
        ...base.design,
        unroute: async (_dir, nets) => {
          order.push(`remove:${nets?.join(",")}`);
          await Bun.write(board, "route-removed\n");
          return { tracks: 12, vias: 2 };
        },
        editBoardGeometry: async (_dir, edit) => {
          order.push(`create:${edit.tracks?.length ?? 0}`);
          await Bun.write(board, `${await Bun.file(board).text()}replacement-route\n`);
          return {
            created: { tracks: 1, vias: 0, zones: 0, keepouts: 0, texts: 0, graphics: 0 },
            createdIds: ["track-replacement"],
            deletedIds: [],
            revision: 9,
            saved: true,
          };
        },
      },
    });
    const factory = contextFactory(services, project);
    const call = (args: Record<string, unknown>) =>
      reg.invoke("pcb_edit_copper", args, (ref) =>
        factory({
          def: reg.get("pcb_edit_copper")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      );

    await expect(call({ mode: "apply", removeNets: ["A", "B", "C", "D"] })).rejects.toThrow(
      /copper removal has no replacement/,
    );
    expect(await Bun.file(board).text()).toBe("existing-route\n");
    expect(order).toEqual([]);

    const accepted = await call({
      mode: "apply",
      expectedPcbRevision: revision,
      removeNets: ["A", "B", "C", "D"],
      candidateFile,
    });
    expect(order).toEqual(["remove:A,B,C,D", "create:1"]);
    expect(await Bun.file(board).text()).toBe("route-removed\nreplacement-route\n");
    expect((accepted.json as any).candidateFile).toBe(candidateFile);
    expect((accepted.json as any).changes).toMatchObject({
      removedCopper: { tracks: 12, vias: 2 },
      geometry: { created: { tracks: 1 } },
    });
  });

  test("complete release is revision-bound and fails closed on missing outputs", async () => {
    const reg = createRegistry();
    const project = await tempProject("release");
    for (const [name, body] of [
      ["board.kicad_sch", "sch"],
      ["board.kicad_pcb", "pcb"],
      ["board.kicad_pro", "{}"],
    ])
      await writeFile(join(project.dir, name), body);
    const base = mockServices([project]);
    const put = async (path: string, body = "output") => {
      await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
      await Bun.write(path, body);
    };
    const services = mockServices([project], {
      kicad: {
        ...base.kicad,
        renderPng: async (_cli, { output }) => put(output, "png"),
        exportSchematicSvg: async (_cli, { outDir }) => {
          await mkdir(outDir, { recursive: true });
          const path = join(outDir, "board.svg");
          await put(path, "svg");
          return { paths: [path] };
        },
        exportSchematicPdf: async (_cli, { output }) => {
          await put(output, "pdf");
          return { paths: [output] };
        },
        exportPcbSvg: async (_cli, { output }) => {
          await put(output, "svg");
          return { paths: [output] };
        },
        exportGerbers: async (_cli, { outDir }) => {
          const gbr = join(outDir, "board-F_Cu.gbr"),
            job = join(outDir, "board-job.gbrjob");
          await put(gbr);
          await put(job);
          return { paths: [gbr, job] };
        },
        exportDrill: async (_cli, { outDir }) => {
          const path = join(outDir, "board.drl");
          await put(path);
          return { paths: [path] };
        },
        exportPos: async (_cli, { output }) => {
          await put(output);
          return { paths: [output] };
        },
        exportBom: async (_cli, { output }) => {
          await put(output);
          return { paths: [output] };
        },
        exportNetlist: async (_cli, { output }) => {
          await put(output);
          return { paths: [output] };
        },
      },
    });
    const factory = contextFactory(services, project);
    const release = await reg.invoke(
      "release_build",
      {
        buildNotes: "Fit LED with marked cathode.",
        circuitChecks: [
          {
            kind: "led-current",
            supplyVolts: 5,
            forwardVolts: 2,
            resistanceOhms: 1000,
            minMa: 2,
            maxMa: 4,
          },
          {
            kind: "assertion",
            name: "Firmware controls the LED",
            pass: true,
            evidence: "Firmware will implement this behavior.",
          },
        ],
      },
      (ref) =>
        factory({
          def: reg.get("release_build")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
    );
    expect(release.isError).toBeFalsy();
    expect((release.json as any).pass).toBe(true);
    expect((release.json as any).contract.version).toBe("1.1.0");
    expect((release.json as any).verification).toEqual({
      status: "pass",
      scope: "configured release checks and outputs",
      productCompletenessAssessed: false,
    });
    expect(release.text).toMatch(/Saved-file ERC measured by packaged kicad-cli 10\.99\.0/);
    expect((release.json as any).checks.erc).toMatchObject({
      evidenceLevel: "measured",
      source: "packaged-kicad-cli",
      scope: "saved board.kicad_sch",
      revision: (release.json as any).revisions.schematic,
    });
    expect((release.json as any).checks.circuit).toEqual([
      expect.objectContaining({ kind: "led-current", evidenceLevel: "computed", status: "pass" }),
      expect.objectContaining({
        kind: "assertion",
        evidenceLevel: "declared",
        status: "declared",
        claim: "pass",
      }),
    ]);
    expect((release.json as any).checks.circuit[1].measured).toBeUndefined();
    expect((release.json as any).evidence.declaredClaims).toEqual([
      {
        name: "Firmware controls the LED",
        claim: "pass",
        evidence: "Firmware will implement this behavior.",
      },
    ]);
    expect((release.json as any).revisions.schematic).toHaveLength(64);
    expect(
      (release.json as any).inventory.some(
        (entry: any) => entry.path === "exports/fabrication.zip" && entry.status === "available",
      ),
    ).toBe(true);
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
      ...reg
        .manifest()
        .flatMap((tool) => [tool.title, tool.description, JSON.stringify(tool.inputSchema)]),
      toolsMarkdown(reg),
    ].join("\n");
    expect(agentFacing).not.toMatch(
      /run [^.\n]* first|use [^.\n]* (?:before|after)|prefer|repeat until|retry|required workflow|must use|should use|stop after|only after|release checklist|stopping policy/i,
    );
  });

  test("project status distinguishes source builds from current, stale, failed, and missing releases", async () => {
    const reg = createRegistry();
    const project = await tempProject("release-status");
    const reports = join(project.dir, "reports");
    await mkdir(reports, { recursive: true });
    const schematic = join(project.dir, "board.kicad_sch");
    const pcb = join(project.dir, "board.kicad_pcb");
    await writeFile(schematic, "schematic-v1");
    await writeFile(pcb, "pcb-v1");
    const sha = async (path: string) =>
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    const release = {
      capturedAt: "2026-09-17T06:01:36.848Z",
      pass: true,
      revisions: { schematic: await sha(schematic), pcb: await sha(pcb) },
      inventory: Array.from({ length: 39 }, (_, index) => ({
        path: `output-${index}`,
        status: "available",
      })),
    };
    await writeFile(join(reports, "release.json"), JSON.stringify(release));
    const services = mockServices([project]);
    const invoke = () =>
      reg.invoke("project_status", {}, (ref) =>
        contextFactory(
          services,
          project,
        )({
          def: reg.get("project_status")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      );

    const current = await invoke();
    expect(current.text).toContain("Last source/compiler build: never");
    expect(current.text).toContain(
      "Last release: PASS (39/39 outputs, captured 2026-09-17T06:01:36.848Z",
    );
    expect(current.text).toContain("current native files match");
    expect(current.text).not.toContain("Last build:");
    expect(current.json).toMatchObject({
      contract: { name: "fabdesk.project-status", version: "2.0.0" },
      lastSourceBuild: null,
      lastRelease: { status: "pass", stale: false, outputs: { available: 39, total: 39 } },
    });
    expect((current.json as any).lastBuild).toBeUndefined();

    await writeFile(schematic, "schematic-v2");
    const stale = await invoke();
    expect(stale.text).toContain("Last release: PASS");
    expect(stale.text).toContain("STALE relative to current native files");
    expect((stale.json as any).lastRelease.stale).toBe(true);

    await writeFile(
      join(reports, "release.json"),
      JSON.stringify({ ...release, pass: false, inventory: release.inventory.slice(0, 38) }),
    );
    const failed = await invoke();
    expect(failed.text).toContain("Last release: FAIL");
    expect((failed.json as any).lastRelease.status).toBe("fail");

    await writeFile(join(reports, "release.json"), JSON.stringify({ pass: true }));
    const missing = await invoke();
    expect(missing.text).toContain("Last release: missing");
    expect((missing.json as any).lastRelease.status).toBe("missing");

    const neverProject = await tempProject("never-release");
    const neverServices = mockServices([neverProject]);
    const never = await reg.invoke("project_status", {}, (ref) =>
      contextFactory(
        neverServices,
        neverProject,
      )({
        def: reg.get("project_status")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
    );
    expect(never.text).toContain("Last release: never");
    expect((never.json as any).lastRelease).toEqual({ status: "never" });
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
    const environment = await reg.invoke("pcb_environment", { project: project.id }, (ref) =>
      noProject({
        def: reg.get("pcb_environment")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
    );
    expect(environment.text).toContain("/mock/kicad-cli (10.99.0)");
    expect(environment.text).toContain("State visibility:");
    expect(environment.text).not.toContain("deliberately");
    expect(environment.json).toMatchObject({
      project: { dir: project.dir },
      kicadCli: { path: "/mock/kicad-cli", version: "10.99.0" },
      bridge: { url: "http://127.0.0.1:4020", ok: true },
      uiConventions: { canonicalFiles: { board: join(project.dir, "board.kicad_pcb") } },
    });
    expect((out.json as any)._contract).toEqual(reg.contract());
    const symbols = await reg.invoke(
      "circuit_search_parts",
      { query: "resistor", kind: "symbol" },
      (ref) =>
        noProject({
          def: reg.get("circuit_search_parts")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
    );
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
          return {
            tracks: 0,
            vias: 0,
            claimedVias: 0,
            routed: 0,
            total: 1,
            trackLengthNm: 0,
            elapsedMs: 1,
            wallMs: 1,
            timedOut: false,
            message: "blocked by edge clearance",
            unrouted: [{ net: "N1", from: { x: 0, y: 0 }, to: { x: 5, y: 5 } }],
            geometry: [],
            log: ["endpoint blocked by board edge"],
          };
        },
      },
    });
    const factory = contextFactory(services, project);
    const call = (args: Record<string, unknown>) =>
      reg.invoke("route_run", args, (ref) =>
        factory({
          def: reg.get("route_run")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      );
    const blocked = await call({ timeoutMs: 5000, targets: [{ net: "NOT_A_NET" }] });
    expect((blocked.json as any).state).toBe("blocked");
    const unavailable = await call({ timeoutMs: 5000, router: "freerouting" });
    expect((unavailable.json as any).state).toBe("unavailable");
    const noProgress = await call({
      timeoutMs: 5000,
      targets: [{ net: "N1" }],
      rules: { widthMm: 0.25, clearanceMm: 0.2 },
    });
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
