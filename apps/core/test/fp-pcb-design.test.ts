import { describe, expect, test } from "bun:test";
import type { FpPcbCompileJob } from "@fabdesk/protocol";
import { create } from "@bufbuild/protobuf";
import { BoardLayer, FootprintInstanceSchema, PadSchema, packAny } from "@fp-pcb/proto";
import { Footprint, createBoardGraphic } from "@fp-pcb/client";
import {
  createFpPcbDesign,
  evaluatePartCompatibility,
  persistDefaultNetClass,
} from "../src/fp-pcb-design";
import type { FpPcbBridgeClient } from "../src/fp-pcb-bridge";
import { FpPcbSessions, type ProjectSession } from "../src/fp-pcb-session";

describe("FabPCB build recovery", () => {
  test("releases a bare session when NewProject leaves a board behind", async () => {
    const released: string[] = [];
    const job = {
      id: "compile-1",
      sessionId: "session-1",
      frontend: "netlist-json",
      state: "failed",
      startedAt: new Date().toISOString(),
      log: [],
      error: "NewProject: AS_BAD_REQUEST - request failed: Failed to load kiface library",
    } as FpPcbCompileJob;
    const bridge = {
      compile: async () => job,
    } as unknown as FpPcbBridgeClient;
    const session = { id: "session-1", path: null } as ProjectSession;
    const sessions = {
      withRetry: async (
        _projectDir: string,
        run: (value: ProjectSession) => Promise<FpPcbCompileJob>,
      ) => run(session),
      release: async (projectDir: string) => {
        released.push(projectDir);
      },
    } as unknown as FpPcbSessions;
    const design = createFpPcbDesign({
      bridge: () => bridge,
      sessions,
      readText: async () => "{}",
      exists: async (path) =>
        path.endsWith("circuit.netlist.json") || path.endsWith("board.kicad_pcb"),
    });

    const result = await design.build({ projectDir: "/workspace/partial" });
    expect(result.ok).toBe(false);
    expect(released).toEqual(["/workspace/partial"]);
  });

  test("reports the built board's copper layer count, and survives failing to read it", async () => {
    const job = {
      id: "compile-2",
      sessionId: "session-2",
      frontend: "netlist-json",
      state: "done",
      startedAt: new Date().toISOString(),
      log: [],
      result: {
        ok: true,
        diagnostics: [],
        counts: {
          components: 1,
          nets: 1,
          viasAdded: 0,
          holesAdded: 0,
          footprintsAdded: 1,
          footprintsPlaced: 1,
        },
        durationMs: 1,
      },
    } as FpPcbCompileJob;
    const bridge = { compile: async () => job } as unknown as FpPcbBridgeClient;
    const session = { id: "session-2", path: "/workspace/four/board.kicad_pro" } as ProjectSession;
    let enabledLayers: () => Promise<{
      copperLayerCount: number;
      layers: BoardLayer[];
    }> = async () => ({ copperLayerCount: 4, layers: [] });
    const sessions = {
      withRetry: async (
        _projectDir: string,
        run: (value: ProjectSession) => Promise<FpPcbCompileJob>,
      ) => run(session),
      board: async () => ({ enabledLayers: () => enabledLayers() }),
    } as unknown as FpPcbSessions;
    const design = createFpPcbDesign({
      bridge: () => bridge,
      sessions,
      readText: async () => "{}",
      exists: async () => true,
    });

    const built = await design.build({ projectDir: "/workspace/four" });
    expect(built.ok).toBe(true);
    expect(built.copperLayers).toBe(4);

    enabledLayers = async () => {
      throw new Error("board went away");
    };
    const unread = await design.build({ projectDir: "/workspace/four" });
    expect(unread.ok).toBe(true);
    expect(unread.copperLayers).toBeUndefined();
  });
});

describe("PCB geometry query boundaries", () => {
  test("separates board-owned shapes from explicitly requested footprint primitives", async () => {
    const boardShape = createBoardGraphic({
      geometry: {
        kind: "segment",
        start: { x: 1_000_000, y: 2_000_000 },
        end: { x: 11_000_000, y: 2_000_000 },
      },
      layer: BoardLayer.BL_Edge_Cuts,
    });
    const courtyard = createBoardGraphic({
      geometry: {
        kind: "segment",
        start: { x: 3_000_000, y: 4_000_000 },
        end: { x: 5_000_000, y: 4_000_000 },
      },
      layer: BoardLayer.BL_F_CrtYd,
    });
    const fabrication = createBoardGraphic({
      geometry: {
        kind: "segment",
        start: { x: 3_000_000, y: 5_000_000 },
        end: { x: 5_000_000, y: 5_000_000 },
      },
      layer: BoardLayer.BL_F_Fab,
    });
    const silkscreen = createBoardGraphic({
      geometry: {
        kind: "segment",
        start: { x: 3_000_000, y: 6_000_000 },
        end: { x: 5_000_000, y: 6_000_000 },
      },
      layer: BoardLayer.BL_F_Silkscreen,
    });
    const board = {
      getShapes: async () => [boardShape],
      getFootprints: async () => [{ reference: "R1", items: [courtyard, fabrication, silkscreen] }],
    };
    const sessions = {
      board: async () => board,
    } as unknown as FpPcbSessions;
    const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions });

    expect(await design.query("/workspace/project", "board_geometry")).toEqual([
      expect.objectContaining({
        id: boardShape.id,
        owner: "board",
        layer: BoardLayer.BL_Edge_Cuts,
        start: { x: 1, y: 2 },
        end: { x: 11, y: 2 },
      }),
    ]);
    expect(await design.query("/workspace/project", "footprint_geometry")).toEqual([
      expect.objectContaining({
        id: courtyard.id,
        owner: "R1",
        layer: BoardLayer.BL_F_CrtYd,
        start: { x: 3, y: 4 },
        end: { x: 5, y: 4 },
      }),
      expect.objectContaining({
        id: fabrication.id,
        owner: "R1",
        layer: BoardLayer.BL_F_Fab,
        start: { x: 3, y: 5 },
        end: { x: 5, y: 5 },
      }),
    ]);
  });
});

describe("part compatibility", () => {
  const suitable = {
    role: "power-only-usb-c" as const,
    suitable: true,
    reasons: ["required pins present"],
  };
  const symbol = {
    kind: "symbol" as const,
    libId: "Connector:USB_C_PowerOnly_6P",
    description: "USB-C power-only receptacle",
    pins: ["A5", "B5", "A9", "B9", "A12", "B12"].map((number) => ({
      number,
      name: number.endsWith("5") ? "CC" : number.endsWith("9") ? "VBUS" : "GND",
      electricalType: "PT_PASSIVE",
      position: { x: 0, y: 0 },
    })),
    roleSuitability: [suitable],
  };

  test("accepts matching electrical pads and ignores shield pads", () => {
    const footprint = {
      kind: "footprint" as const,
      libId: "Connector_USB:USB_C_6P",
      description: "USB-C power-only footprint",
      pads: [
        ...symbol.pins.map(({ number }) => ({
          number,
          position: { x: 0, y: 0 },
          size: { x: 1, y: 1 },
        })),
        { number: "SH", position: { x: 0, y: 0 }, size: { x: 1, y: 1 } },
      ],
      roleSuitability: [suitable],
    };
    expect(evaluatePartCompatibility(symbol, footprint, "power-only-usb-c")).toMatchObject({
      compatible: true,
      pinPad: { compatible: true, missingPadsForPins: [], padsWithoutPins: ["SH"] },
      role: { suitable: true },
      warnings: [expect.stringContaining("shield pad SH")],
    });
  });

  test("fails closed on a missing pin mapping or unsupported requested role", () => {
    const footprint = {
      kind: "footprint" as const,
      libId: "Connector_USB:wrong",
      description: "generic connector",
      pads: [{ number: "A5", position: { x: 0, y: 0 }, size: { x: 1, y: 1 } }],
    };
    const result = evaluatePartCompatibility(symbol, footprint, "power-only-usb-c");
    expect(result).toMatchObject({
      compatible: false,
      pinPad: { compatible: false, missingPadsForPins: ["A12", "A9", "B12", "B5", "B9"] },
      role: { suitable: false },
    });
    expect(result.issues.some((issue) => issue.includes("no footprint pad"))).toBe(true);
  });
});

/** A KiCad stand-in: library commands answer only once a project is open, like the api-server. */
function fakeKicad(opts: { projectOpen: boolean }) {
  let projectOpen = opts.projectOpen;
  const calls: string[] = [];
  const kicad = {
    projectInfo: async () => {
      calls.push("projectInfo");
      if (!projectOpen) throw new Error("GetProjectInfo: AS_BAD_REQUEST - no project is open");
      return { kicadProPath: "/tmp/x.kicad_pro", files: [] };
    },
    newProject: async (path: string) => {
      calls.push(`newProject ${path.endsWith(".kicad_pro") ? "ok" : path}`);
      projectOpen = true;
      return {};
    },
    libraries: {
      nicknames: async (type: string) => {
        calls.push(`nicknames ${type}`);
        if (!projectOpen) throw new Error("GetLibraryTables: AS_UNHANDLED - no handler available");
        return ["Package_TO_SOT_SMD", "Resistor_SMD"];
      },
      entries: async (_type: string, nickname: string, filter: string) => {
        calls.push(`entries ${nickname} ${filter}`);
        return nickname === "Package_TO_SOT_SMD" && /sot-23-5/.test(filter)
          ? [{ name: "SOT-23-5", description: "5-pin SOT-23" }, { name: "SOT-23-5_HandSoldering" }]
          : [];
      },
    },
  };
  return { kicad, calls };
}

function sessionsFor(kicad: unknown): FpPcbSessions {
  const session = async () => ({ id: "s1", kicad, ws: {}, path: null });
  const withRetry = async (_dir: string, fn: (s: unknown) => Promise<unknown>) =>
    fn(await session());
  return { session, withRetry } as unknown as FpPcbSessions;
}

describe("searchFootprints", () => {
  test("gives the bare library session a scratch project before asking for library tables", async () => {
    const { kicad, calls } = fakeKicad({ projectOpen: false });
    const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions: sessionsFor(kicad) });
    const hits = await design.searchFootprints("SOT-23-5", 5);
    expect(hits.map((h) => h.libId)).toEqual([
      "Package_TO_SOT_SMD:SOT-23-5",
      "Package_TO_SOT_SMD:SOT-23-5_HandSoldering",
    ]);
    expect(calls.slice(0, 3)).toEqual(["projectInfo", "newProject ok", "nicknames footprint"]);
    // The project stays open on the shared session: the second search creates nothing.
    await design.searchFootprints("R_0603", 5);
    expect(calls.filter((c) => c.startsWith("newProject"))).toHaveLength(1);
  });

  test("leaves a session that already holds a project alone", async () => {
    const { kicad, calls } = fakeKicad({ projectOpen: true });
    const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions: sessionsFor(kicad) });
    await design.searchFootprints("SOT-23-5", 5);
    expect(calls.some((c) => c.startsWith("newProject"))).toBe(false);
  });

  test("ranks entries across libraries instead of stopping at the first vendor matches", async () => {
    const kicad = {
      projectInfo: async () => ({ kicadProPath: "/tmp/x.kicad_pro", files: [] }),
      libraries: {
        nicknames: async () => ["LED", "Device"],
        entries: async (_type: string, nickname: string) =>
          nickname === "LED"
            ? [
                { name: "APA102", description: "Serial RGB LED", keywords: "LED" },
                { name: "APFA3010", description: "Vendor LED", keywords: "LED" },
              ]
            : [{ name: "LED", description: "Light emitting diode", keywords: "LED diode" }],
      },
    };
    const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions: sessionsFor(kicad) });
    const hits = await design.searchSymbols("LED", 10);
    expect(hits.map((hit) => hit.libId)).toEqual(["Device:LED", "LED:APA102", "LED:APFA3010"]);
  });
});

describe("searchFootprints after a bridge restart", () => {
  test("a gone library session is reconnected once and the search retried", async () => {
    const { kicad } = fakeKicad({ projectOpen: true });
    let attempts = 0;
    const gone = {
      ...kicad,
      libraries: {
        ...kicad.libraries,
        nicknames: async (type: string) => {
          attempts++;
          if (attempts === 1)
            throw new Error(
              "WebSocket ws://127.0.0.1:4020/ws?session=x closed (code 1006: Connection ended)",
            );
          return kicad.libraries.nicknames(type);
        },
      },
    };
    const sessions = new FpPcbSessions(() => ({}) as never);
    let releases = 0;
    sessions.session = async () => ({
      id: "s1",
      kicad: gone as never,
      ws: {} as never,
      path: null,
    });
    sessions.release = async () => {
      releases++;
    };
    const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions });
    const hits = await design.searchFootprints("SOT-23-5", 5);
    expect(attempts).toBe(2);
    expect(releases).toBe(1);
    expect(hits[0]?.libId).toBe("Package_TO_SOT_SMD:SOT-23-5");
  });

  test("an entries call interrupted by a bridge restart retries the complete search", async () => {
    const { kicad } = fakeKicad({ projectOpen: true });
    let attempts = 0;
    const gone = {
      ...kicad,
      libraries: {
        ...kicad.libraries,
        entries: async (...args: Parameters<typeof kicad.libraries.entries>) => {
          attempts++;
          if (attempts === 1) throw new Error("WebSocket closed (code 1006: Connection ended)");
          return kicad.libraries.entries(...args);
        },
      },
    };
    const sessions = new FpPcbSessions(() => ({}) as never);
    sessions.session = async () => ({
      id: "s1",
      kicad: gone as never,
      ws: {} as never,
      path: null,
    });
    sessions.release = async () => {};
    const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions });
    expect((await design.searchFootprints("SOT-23-5", 5))[0]?.libId).toBe(
      "Package_TO_SOT_SMD:SOT-23-5",
    );
    expect(attempts).toBeGreaterThan(1);
  });
});

describe("copper edits refill pours before saving", () => {
  // Reported from PCBGolf leftover routing: a via added through the agent copper path landed in
  // pours that still predated it, so native DRC reported clearance errors that were artifacts of
  // the edit rather than the design. route_run already refilled via rules.refillZones; nothing
  // else did.
  const fakeBoard = (opts: { refill?: () => Promise<void> } = {}) => {
    const calls: string[] = [];
    return {
      calls,
      board: {
        nets: async () => [{ name: "GND", code: { value: 1 } }],
        commit: async (_msg: string, run: (tx: unknown) => Promise<unknown> | unknown) => {
          calls.push("commit");
          await run({ create: async () => [], delete: async () => undefined });
          return { created: [], deleted: [] };
        },
        revision: async () => 4n,
        getTracks: async () => [],
        refillZones: async () => {
          calls.push("refillZones");
          if (opts.refill) await opts.refill();
        },
        save: async () => {
          calls.push("save");
        },
      },
    };
  };

  test("editBoardGeometry refills between the commit and the save", async () => {
    const { calls, board } = fakeBoard();
    const design = createFpPcbDesign({
      bridge: () => ({}) as never,
      sessions: { board: async () => board } as unknown as FpPcbSessions,
    });
    const result = await design.editBoardGeometry("/workspace/project", {
      vias: [
        {
          position: { x: 10, y: 10 },
          diameter: 0.36,
          drill: 0.2,
          layers: ["F.Cu", "B.Cu"],
          net: "GND",
        },
      ],
    } as never);
    expect(calls).toEqual(["commit", "refillZones", "save"]);
    expect(result.zoneRefill).toEqual({ refilled: true });
  });

  test("a board that cannot refill still saves the copper, and says the pours are stale", async () => {
    const { calls, board } = fakeBoard({
      refill: async () => {
        throw new Error("no zones on this board");
      },
    });
    const design = createFpPcbDesign({
      bridge: () => ({}) as never,
      sessions: { board: async () => board } as unknown as FpPcbSessions,
    });
    const result = await design.editBoardGeometry("/workspace/project", {
      tracks: [
        {
          start: { x: 0, y: 0 },
          end: { x: 1, y: 1 },
          width: 0.2,
          layer: "F.Cu",
          net: "GND",
        },
      ],
    } as never);
    expect(calls).toEqual(["commit", "refillZones", "save"]);
    expect(result.zoneRefill).toEqual({ refilled: false, error: "no zones on this board" });
  });
});

describe("persistDefaultNetClass", () => {
  const io = (files: Record<string, string>) => {
    const fs = {
      files,
      writes: 0,
      readText: async (p: string) => {
        if (!(p in files)) throw new Error("ENOENT");
        return files[p]!;
      },
      writeText: async (p: string, text: string) => {
        fs.writes++;
        files[p] = text;
      },
    };
    return fs;
  };

  test("writes the Default class into a project file that has none", async () => {
    const fs = io({
      "/p/board.kicad_pro": JSON.stringify({
        board: { design_settings: { rules: { min_clearance: 0.15 } } },
        net_settings: { classes: [], meta: { version: 4 } },
      }),
    });
    expect(
      await persistDefaultNetClass(
        "/p/board.kicad_pro",
        { clearanceMm: 0.15, trackWidthMm: 0.15, viaDiameterMm: 0.45, viaDrillMm: 0.25 },
        fs,
      ),
    ).toBe(true);
    const pro = JSON.parse(fs.files["/p/board.kicad_pro"]!);
    expect(pro.net_settings.classes).toEqual([
      {
        name: "Default",
        priority: 2147483647,
        clearance: 0.15,
        track_width: 0.15,
        via_diameter: 0.45,
        via_drill: 0.25,
      },
    ]);
    expect(pro.net_settings.meta).toEqual({ version: 4 });
    expect(pro.board.design_settings.rules.min_clearance).toBe(0.15);
  });

  test("merges into an existing Default class and leaves fields the rules do not name", async () => {
    const fs = io({
      "/p/board.kicad_pro": JSON.stringify({
        net_settings: {
          classes: [
            { name: "Default", clearance: 0.2, track_width: 0.25, diff_pair_gap: 0.25 },
            { name: "Power", track_width: 0.5 },
          ],
        },
      }),
    });
    await persistDefaultNetClass("/p/board.kicad_pro", { clearanceMm: 0.1 }, fs);
    const pro = JSON.parse(fs.files["/p/board.kicad_pro"]!);
    expect(pro.net_settings.classes[0]).toEqual({
      name: "Default",
      clearance: 0.1,
      track_width: 0.25,
      diff_pair_gap: 0.25,
    });
    expect(pro.net_settings.classes[1]).toEqual({ name: "Power", track_width: 0.5 });
  });

  test("leaves a file that already holds the class untouched (the save kept it)", async () => {
    const text = JSON.stringify({
      net_settings: { classes: [{ name: "Default", clearance: 0.15, track_width: 0.15 }] },
    });
    const fs = io({ "/p/board.kicad_pro": text });
    expect(
      await persistDefaultNetClass(
        "/p/board.kicad_pro",
        { clearanceMm: 0.15, trackWidthMm: 0.15 },
        fs,
      ),
    ).toBe(true);
    expect(fs.writes).toBe(0);
    expect(fs.files["/p/board.kicad_pro"]).toBe(text);
  });

  test("does nothing without a project file", async () => {
    const fs = io({});
    expect(await persistDefaultNetClass("/p/board.kicad_pro", { clearanceMm: 0.1 }, fs)).toBe(
      false,
    );
    expect(Object.keys(fs.files)).toEqual([]);
  });
});

describe("what a successful build checks against the saved board", () => {
  type At = [ref: string, x: number, y: number];
  const pcbText = (refs: At[]) =>
    `(kicad_pcb\n${refs
      .map(
        ([ref, x, y]) =>
          `\t(footprint "R" (layer "F.Cu") (at ${x} ${y} 0)\n\t\t(property "Reference" "${ref}" (at 0 0 0))\n\t)`,
      )
      .join("\n")}\n)`;

  const setup = (opts: { file: At[]; session: At[] }) => {
    const calls: string[] = [];
    const files: Record<string, string> = {
      "/w/circuit.netlist.json": JSON.stringify({
        board: { rules: { clearanceMm: 0.15, trackWidthMm: 0.15 } },
      }),
      "/w/board.kicad_pcb": pcbText(opts.file),
      "/w/board.kicad_pro": JSON.stringify({ net_settings: { classes: [] } }),
    };
    const job = {
      id: "compile-1",
      sessionId: "session-1",
      frontend: "netlist-json",
      state: "succeeded",
      startedAt: new Date().toISOString(),
      log: [],
      result: {
        ok: true,
        diagnostics: [],
        counts: { components: 3, nets: 1, footprintsAdded: 3, footprintsPlaced: 3 },
      },
    } as unknown as FpPcbCompileJob;
    const board = {
      getFootprints: async () =>
        opts.session.map(([reference, x, y]) => ({
          reference,
          position: { x: x * 1_000_000, y: y * 1_000_000 },
        })),
      close: async () => {
        calls.push("close");
      },
    };
    const session = {
      id: "session-1",
      path: "/w/board.kicad_pro",
      kicad: {
        currentBoard: async () => board,
        openBoard: async (path: string) => {
          calls.push(`open ${path}`);
          return board;
        },
      },
    } as unknown as ProjectSession;
    const sessions = {
      withRetry: async <T>(_dir: string, run: (s: ProjectSession) => Promise<T>) => run(session),
      release: async () => undefined,
      board: async () => ({ enabledLayers: async () => ({ copperLayerCount: 2 }) }),
    } as unknown as FpPcbSessions;
    const design = createFpPcbDesign({
      bridge: () => ({ compile: async () => job }) as unknown as FpPcbBridgeClient,
      sessions,
      readText: async (p) => {
        if (!(p in files)) throw new Error("ENOENT");
        return files[p]!;
      },
      writeText: async (p, text) => {
        files[p] = text;
      },
      exists: async (p) => p in files,
    });
    return { calls, files, design };
  };

  test("warns when parts share one origin, whatever the compile counted", async () => {
    const at: At[] = [
      ["C1", 0, 0],
      ["C2", 0, 0],
      ["R1", 5, 5],
    ];
    const { design } = setup({ file: at, session: at });
    const result = await design.build({ projectDir: "/w" });
    expect(result.ok).toBe(true);
    const stacked = result.warnings.find((w) => w.type === "footprints_stacked");
    expect(stacked?.message).toContain("2 footprints share one position");
    expect(stacked?.message).toContain("C1, C2");
  });

  test("reopens the board only when the session's positions disagree with the file", async () => {
    const same = setup({ file: [["R1", 5, 5]], session: [["R1", 5, 5]] });
    await same.design.build({ projectDir: "/w" });
    expect(same.calls).toEqual([]);

    const stale = setup({ file: [["R1", 5, 5]], session: [["R1", 0, 0]] });
    const result = await stale.design.build({ projectDir: "/w" });
    expect(stale.calls).toEqual(["close", "open /w/board.kicad_pcb"]);
    expect(result.warnings).toEqual([]);
  });

  test("writes the netlist's rules into the project's Default net class", async () => {
    const { files, design } = setup({ file: [["R1", 5, 5]], session: [["R1", 5, 5]] });
    await design.build({ projectDir: "/w" });
    const pro = JSON.parse(files["/w/board.kicad_pro"]!);
    expect(pro.net_settings.classes[0]).toMatchObject({
      name: "Default",
      clearance: 0.15,
      track_width: 0.15,
    });
  });
});

describe("embedded footprint placement recovery", () => {
  function setup(
    options: { failSave?: boolean; failRestore?: boolean; unsavedSchematic?: boolean } = {},
  ) {
    const original = new Footprint(
      create(FootprintInstanceSchema, {
        id: { value: "connector" },
        position: { xNm: 10000000n, yNm: 20000000n },
        orientation: { valueDegrees: -90 },
        layer: BoardLayer.BL_F_Cu,
        referenceField: {
          text: {
            text: { text: "J13", position: { xNm: 10000000n, yNm: 20000000n }, attributes: {} },
          },
        },
        definition: {
          id: { libraryNickname: "Missing", entryName: "Embedded" },
          items: [
            packAny(
              PadSchema,
              create(PadSchema, {
                id: { value: "pad1" },
                number: "1",
                position: { xNm: 11000000n, yNm: 22000000n },
                net: { name: "GND", code: { value: 1 } },
              }),
            ),
          ],
        },
      }),
    );
    let live = original.clone();
    const files: Record<string, string> = {
      "/p/board.kicad_pcb": "original pcb",
      "/p/board.kicad_pro": "original project",
    };
    const calls: string[] = [];
    let failSave = options.failSave ?? false;
    const board = {
      getFootprints: async () => [live],
      revision: async () => 3n,
      updateFootprintsFromLibrary: async () => {
        throw new Error("unexpected library access");
      },
      commit: async (
        _message: string,
        run: (tx: { update: (items: Footprint[]) => Promise<void> }) => Promise<void>,
      ) => {
        const before = live.clone();
        calls.push("commit");
        try {
          await run({
            update: async (items) => {
              live = items[0]!.clone();
            },
          });
        } catch (error) {
          live = before;
          throw error;
        }
      },
      save: async () => {
        calls.push("save");
        files["/p/board.kicad_pcb"] = `angle ${live.orientation}`;
        if (failSave) {
          failSave = false;
          throw new Error("save failed after write");
        }
      },
    };
    const design = createFpPcbDesign({
      bridge: () => ({}) as never,
      sessions: {
        board: async () => board,
        assertSchematicSaved: async () => {
          if (options.unsavedSchematic) throw new Error("save the open schematic");
        },
        release: async () => {
          calls.push("release");
          live = original.clone();
        },
      } as unknown as FpPcbSessions,
      readText: async (path) => {
        if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return files[path]!;
      },
      writeText: async (path, text) => {
        if (options.failRestore && path.endsWith(".kicad_pcb")) throw new Error("restore failed");
        files[path] = text;
        calls.push(`restore ${path}`);
      },
    });
    return { design, original, files, calls, live: () => live };
  }
  test("moves and physically rotates embedded pads without accessing a library", async () => {
    const state = setup();
    const result = await state.design.placeFootprints("/p", [
      { reference: "J13", position: { x: 20, y: 30 }, rotation: 90 },
    ]);
    expect(result).toMatchObject({ moved: ["J13"], saved: true, libraryNormalized: 0 });
    expect(state.live().pads[0]?.position).toEqual({ x: 19000000, y: 28000000 });
    expect(state.original.orientation).toBe(-90);
    expect(state.original.pads[0]?.position).toEqual({ x: 11000000, y: 22000000 });
  });
  test("unknown references and invalid fields reject before any commit", async () => {
    const state = setup();
    const result = await state.design.placeFootprints("/p", [
      { reference: "J13", rotation: 90 },
      { reference: "Unknown", rotation: 90 },
    ]);
    expect(result.saved).toBe(false);
    expect(state.calls).toEqual([]);
    state.live().proto.referenceField!.text!.text!.attributes = undefined;
    await expect(
      state.design.placeFootprints("/p", [
        { reference: "J13", rotation: 90, referenceField: { sizeMm: 0.8 } },
      ]),
    ).rejects.toThrow("no editable reference field");
    expect(state.calls).toEqual([]);
    expect(state.live().orientation).toBe(-90);
  });
  test("save failure restores both live and saved state, and retry performs the edit", async () => {
    const state = setup({ failSave: true });
    await expect(
      state.design.placeFootprints("/p", [{ reference: "J13", rotation: 90 }]),
    ).rejects.toThrow("save failed");
    expect(state.live().equals(state.original)).toBe(true);
    expect(state.files["/p/board.kicad_pcb"]).toBe("original pcb");
    expect(state.files["/p/board.kicad_pro"]).toBe("original project");
    expect(state.calls).toEqual([
      "commit",
      "save",
      "release",
      "restore /p/board.kicad_pcb",
      "restore /p/board.kicad_pro",
    ]);
    const result = await state.design.placeFootprints("/p", [{ reference: "J13", rotation: 90 }]);
    expect(result.moved).toEqual(["J13"]);
    expect(state.live().pads[0]?.position).toEqual({ x: 9000000, y: 18000000 });
  });
  test("unsaved schematic rejects placement without a commit or restart", async () => {
    const state = setup({ unsavedSchematic: true });
    await expect(
      state.design.placeFootprints("/p", [{ reference: "J13", rotation: 90 }]),
    ).rejects.toThrow("save the open schematic");
    expect(state.calls).toEqual([]);
    expect(state.live().equals(state.original)).toBe(true);
  });
  test("a failed PCB restore still restores the project and preserves the original error", async () => {
    const state = setup({ failSave: true, failRestore: true });
    await expect(
      state.design.placeFootprints("/p", [{ reference: "J13", rotation: 90 }]),
    ).rejects.toThrow("save failed after write");
    expect(state.calls).toContain("restore /p/board.kicad_pro");
  });
  test("unknown rotation content rejects before a commit or restart", async () => {
    const state = setup();
    state.live().proto.definition!.items.push({
      $typeName: "google.protobuf.Any",
      typeUrl: "type.googleapis.com/unknown.Child",
      value: new Uint8Array(),
    });
    await expect(
      state.design.placeFootprints("/p", [{ reference: "J13", rotation: 90 }]),
    ).rejects.toThrow("unknown footprint child");
    expect(state.calls).toEqual([]);
  });
  test("equivalent angles are a no-op and reference-field edits remain independent", async () => {
    const state = setup();
    const result = await state.design.placeFootprints("/p", [{ reference: "J13", rotation: 270 }]);
    expect(result.moved).toEqual([]);
    expect(state.live().equals(state.original)).toBe(true);
    await state.design.placeFootprints("/p", [
      {
        reference: "J13",
        referenceField: { position: { x: 12, y: 23 }, sizeMm: 0.8, visible: true },
      },
    ]);
    expect(state.live().referenceField?.position).toEqual({ x: 12000000, y: 23000000 });
    expect(state.live().pads[0]?.position).toEqual(state.original.pads[0]?.position);
  });
});
