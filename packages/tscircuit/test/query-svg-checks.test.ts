import { describe, expect, test } from "bun:test";
import { pcbSvg, queryCircuit, runChecks, schematicSvg } from "../src/index";
import { loadFixtureCircuit } from "./helpers";

describe("queryCircuit", () => {
  test("components rows are compact and filterable", async () => {
    const cj = await loadFixtureCircuit();
    const rows = queryCircuit(cj, "components");
    expect(rows.map((r) => r.name).sort()).toEqual(["J1", "LED1", "R1"]);
    const r1 = rows.find((r) => r.name === "R1")!;
    expect(r1.ftype).toBe("simple_resistor");
    expect(r1.pins).toBe(2);
    expect(typeof r1.pcbX).toBe("number");
    expect(Object.keys(r1)).not.toContain("type"); // never raw elements
    expect(queryCircuit(cj, "components", "led").map((r) => r.name)).toEqual(["LED1"]);
    expect(queryCircuit(cj, "components", "ZZZ")).toEqual([]);
  });

  test("ports, traces, nets and errors", async () => {
    const cj = await loadFixtureCircuit();
    const ports = queryCircuit(cj, "ports", "J1");
    expect(ports.map((p) => p.ref)).toEqual(["J1.VCC", "J1.GND"]);
    const traces = queryCircuit(cj, "traces");
    expect(traces.length).toBe(3);
    expect(traces.every((t) => t.routed === false)).toBe(true);
    expect(queryCircuit(cj, "traces", "gnd").length).toBe(1);
    expect(Array.isArray(queryCircuit(cj, "nets"))).toBe(true);
    const errors = queryCircuit(cj, "errors");
    expect(errors.every((e) => e.severity === "warning")).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("svg", () => {
  test("schematic and pcb svgs render", async () => {
    const cj = await loadFixtureCircuit();
    expect(schematicSvg(cj)).toContain("<svg");
    expect(pcbSvg(cj)).toContain("<svg");
  });
});

describe("runChecks", () => {
  test("reports the unrouted traces of the fixture", async () => {
    const cj = await loadFixtureCircuit();
    const { errors } = await runChecks(cj);
    expect(errors.some((e) => e.type === "pcb_trace_missing_error")).toBe(true);
    for (const e of errors) expect(typeof e.message).toBe("string");
  });
});
