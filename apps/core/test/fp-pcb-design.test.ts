import { describe, expect, test } from "bun:test";
import type { FpPcbCompileJob } from "@fabdesk/protocol";
import { createFpPcbDesign, evaluatePartCompatibility } from "../src/fp-pcb-design";
import type { FpPcbBridgeClient } from "../src/fp-pcb-bridge";
import type { FpPcbSessions, ProjectSession } from "../src/fp-pcb-session";

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
