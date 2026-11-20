import { expect, test } from "bun:test";
import { formatErrors } from "../src/tools/core";

test("compiler multiline diagnostics reach the agent intact", () => {
  const message =
    'U1 pin 8 (VCC) is a power input on no net; connect it.\nNets GND have power-input pins but nothing KiCad counts as a power source.\nIf they really are supplied (a connector, or a part whose output pin is passive), add one PWR_FLAG per net:\n{"ref":"#FLG01","value":"PWR_FLAG","footprint":"","libSource":{"lib":"power","part":"PWR_FLAG"}} and net node {"ref":"#FLG01","pin":"1"}\nIf nothing supplies them, fix the circuit instead.';
  expect(formatErrors([{ type: "power_pin_not_driven", message }])).toBe(
    `- circuit.netlist.json [power_pin_not_driven]: ${message}`,
  );
});

test("circuit_build forwards compiler power diagnostics without lookups or ERC reruns", async () => {
  const { createRegistry } = await import("../src");
  const { toCallToolResult } = await import("../src/adapters/mcp");
  const { contextFactory, mockServices, tempProject } = await import("./mock-services");
  const project = await tempProject("compiler-power-diagnostic");
  const base = mockServices([project]);
  const errors = [
    {
      type: "power_pin_not_driven",
      message: "U1 pin 15 (V+) is a power input on no net; connect it.\nsecond line",
    },
  ];
  const services = mockServices([project], {
    design: {
      ...base.design,
      describePart: async () => {
        throw new Error("unexpected catalog lookup");
      },
      build: async () => ({
        ok: false,
        durationMs: 1,
        errors,
        warnings: [],
        counts: { components: 1, nets: 0, footprintsAdded: 0, footprintsPlaced: 0 },
      }),
    },
    kicad: {
      ...base.kicad,
      runErc: async () => {
        throw new Error("unexpected ERC rerun");
      },
    },
  });
  const registry = createRegistry();
  const factory = contextFactory(services, project);
  const output = await registry.invoke("circuit_build", {}, (ref) =>
    factory({
      def: registry.get("circuit_build")!,
      projectRef: ref,
      signal: new AbortController().signal,
      progress: () => {},
    }),
  );
  expect(output.text).toBe(`Build FAILED (1 errors):\n${formatErrors(errors)}`);
  expect(output.json).toHaveProperty("errors", errors);
  expect(output.json).not.toHaveProperty("powerFlagHelp");
  const agentResult = await toCallToolResult(output, { structured: false });
  expect(agentResult.content).toContainEqual({ type: "text", text: output.text });
});
