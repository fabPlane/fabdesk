import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import type { PartDescription } from "../src/services";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const message = "Generated schematic: Input Power pin not driven by any Output Power pins; unrelated library marker";
const component = (ref: string, part: string) => ({ ref, value: part, footprint: "", libSource: { lib: "Test", part } });
const source = { netlist: {
  components: [component("U1", "Input"), component("U2", "Output"), component("R1", "Passive"), component("#FLG01", "Passive")],
  nets: [
    { name: "+5V", nodes: [{ ref: "U1", pin: "1" }, { ref: "R1", pin: "1" }] },
    { name: "DRIVEN", nodes: [{ ref: "U1", pin: "2" }, { ref: "U2", pin: "1" }] },
    { name: "PASSIVE", nodes: [{ ref: "R1", pin: "2" }] },
  ],
} };
async function build(options: { ok?: boolean; message?: string; failLookup?: boolean; hang?: boolean; unreadable?: boolean; data?: unknown; pins?: PartDescription["pins"] } = {}) {
  const project = await tempProject("power-help");
  // Use an explicit entrypoint to verify the help reads the file actually built.
  if (!options.unreadable) await writeFile(join(project.dir, "custom.json"), JSON.stringify(options.data ?? source));
  const base = mockServices([project]);
  const services = mockServices([project], { design: { ...base.design,
    describePart: async (_kind, libId) => {
      if (options.failLookup) throw new Error("lookup failed");
      if (options.hang) return new Promise<PartDescription>(() => {});
      return { kind: "symbol", libId, description: "", pins: options.pins ?? ["1", "2"].map((number) => ({ number, name: number, position: { x: 0, y: 0 }, electricalType: libId === "Test:Input" ? "PT_POWER_IN" : libId === "Test:Output" ? "PT_POWER_OUT" : "PT_PASSIVE" })) };
    },
    build: async () => ({ ok: options.ok ?? false, durationMs: 1, errors: options.ok ? [] : [{ type: "erc_errors", message: options.message ?? message }], warnings: [], counts: { components: 0, nets: 0, footprintsAdded: 0, footprintsPlaced: 0 } }),
  } });
  const registry = createRegistry(), factory = contextFactory(services, project);
  return registry.invoke("circuit_build", { entrypoint: "custom.json" }, (ref) => factory({ def: registry.get("circuit_build")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
}
test("power help names only undriven power-input nets, handles mixed markers and chooses a free flag", async () => {
  const result = await build();
  expect(result.text).toContain("Nets +5V have power-input pins");
  expect(result.text).toContain('"ref":"#FLG02","value":"PWR_FLAG","footprint":""');
  expect(result.text).toContain('net node {"ref":"#FLG02","pin":"1"}');
  expect(result.text).toContain("If nothing supplies them, fix the circuit instead.");
  expect(result.json).toHaveProperty("powerFlagHelp", { nets: ["+5V"], unconnectedPins: [] });
});
test.each([{ failLookup: true }, { unreadable: true }, { hang: true }])("unknown nets still get bounded help: %j", async (options) => {
  const start = performance.now();
  const result = await build(options);
  expect(result.text).toContain("Some nets have power-input pins");
  expect(result.json).toHaveProperty("powerFlagHelp", { nets: [], unconnectedPins: [] });
  expect(performance.now() - start).toBeLessThan(1500);
});
test("net list is capped at eight with the remaining count", async () => {
  const nets = Array.from({ length: 10 }, (_, i) => ({ name: `N${i}`, nodes: [{ ref: "U1", pin: "1" }] }));
  const result = await build({ data: { netlist: { components: [component("U1", "Input")], nets } }, pins: [{ number: "1", name: "VCC", electricalType: "PT_POWER_IN", position: { x: 0, y: 0 } }] });
  expect(result.text).toContain("Nets N0, N1, N2, N3, N4, N5, N6, N7, +2 more have");
  expect(result.json).toHaveProperty("powerFlagHelp", { nets: nets.map((n) => n.name), unconnectedPins: [] });
});
test.each([{ ok: true }, { message: "different ERC error" }])("unrelated failures and success are unchanged: %j", async (options) => {
  const result = await build(options);
  expect(result.text).not.toContain("PWR_FLAG");
  expect(result.json).not.toHaveProperty("powerFlagHelp");
});

const pin = (number: string, name = "VCC", electricalType = "PT_POWER_IN", x = 0) => ({ number, name, electricalType, position: { x, y: 0 } });
const isolated = (extra = {}) => ({ netlist: { components: [component("U1", "Input")], nets: [], ...extra } });
test("unconnected power pin is named before net advice, including components on no nets", async () => {
  const result = await build({ data: isolated(), pins: [pin("8")] });
  expect(result.text).toContain("U1 pin 8 (VCC) is a power input on no net; connect it.");
  expect(result.text).not.toContain("PWR_FLAG");
  expect(result.json).toHaveProperty("powerFlagHelp", { nets: [], unconnectedPins: [{ ref: "U1", pin: "8", name: "VCC" }] });
  const mixed = await build({ data: isolated({ nets: [{ name: "GND", nodes: [{ ref: "U1", pin: "1" }] }] }), pins: [pin("8"), pin("1", "GND")] });
  expect(mixed.text).toContain("connect it.\nNets GND have");
});
test("flags on all nets leave only the connect line for an unconnected pin", async () => {
  const data = structuredClone(source);
  data.netlist.components = [component("U1", "Input"), component("#FLG01", "Output")];
  data.netlist.nets = [{ name: "VCC", nodes: [{ ref: "U1", pin: "1" }, { ref: "#FLG01", pin: "1" }] }];
  const result = await build({ data });
  expect(result.text).toContain("U1 pin 2 (2) is a power input on no net; connect it.");
  expect(result.text).not.toContain("PWR_FLAG");
});
test("explicit noConnects and stacked same-name same-position wired pins are excluded", async () => {
  const result = await build({ data: isolated({ noConnects: [{ ref: "U1", pin: "8" }] }), pins: [pin("8")] });
  expect(result.json).toHaveProperty("powerFlagHelp", { nets: [], unconnectedPins: [] });
  expect(result.text).not.toContain("connect it");
  expect(result.text).not.toContain("Some nets");
  const stacked = await build({ data: isolated({ nets: [{ name: "VCC", nodes: [{ ref: "U1", pin: "1" }] }] }), pins: [pin("1", "VCC", "PT_POWER_OUT"), pin("8")] });
  expect(stacked.text).not.toContain("connect it");
  expect(stacked.text).not.toContain("PWR_FLAG");
  for (const other of [pin("1", "OTHER", "PT_POWER_OUT"), pin("1", "VCC", "PT_POWER_OUT", 1)]) {
    const separate = await build({ data: isolated({ nets: [{ name: "VCC", nodes: [{ ref: "U1", pin: "1" }] }] }), pins: [other, pin("8")] });
    expect(separate.text).toContain("U1 pin 8 (VCC)");
  }
});
test("all electrical types sharing a pin number count", async () => {
  const data = isolated({ nets: [{ name: "VCC", nodes: [{ ref: "U1", pin: "1" }] }] });
  const input = await build({ data, pins: [pin("1", "P", "PT_PASSIVE"), pin("1")] });
  expect(input.text).toContain("Nets VCC have");
  const output = await build({ data, pins: [pin("1"), pin("1", "VCC", "PT_POWER_OUT")] });
  expect(output.text).not.toContain("PWR_FLAG");
  expect(output.text).not.toContain("Some nets");
});
test("unconnected list caps text at eight but retains all pins in JSON", async () => {
  const result = await build({ data: isolated(), pins: Array.from({ length: 10 }, (_, i) => pin(String(i))) });
  expect(result.text).toContain("+2 more");
  expect(result.text).not.toContain("pin 8");
  expect((result.json as { powerFlagHelp: { unconnectedPins: unknown[] } }).powerFlagHelp.unconnectedPins).toHaveLength(10);
});
test("a completed diagnosis with no candidates does not invent net advice", async () => {
  const result = await build({ data: isolated(), pins: [] });
  expect(result.text).not.toContain("Some nets");
  expect(result.text).not.toContain("PWR_FLAG");
});
