import { describe, expect, test } from "bun:test";
import type { FpPcbCompileJob } from "@fabdesk/protocol";
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
