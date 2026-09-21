import { describe, expect, test } from "bun:test";
import type { FpPcbCompileJob } from "@fabdesk/protocol";
import { BoardLayer } from "@fp-pcb/proto";
import { createBoardGraphic } from "@fp-pcb/client";
import { createFpPcbDesign, evaluatePartCompatibility } from "../src/fp-pcb-design";
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
