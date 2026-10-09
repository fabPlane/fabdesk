import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry, makeContext, type ProjectHandle } from "../src";
import { mockServices, tempProject } from "./mock-services";

async function setup() {
  const project = await tempProject("parts");
  const services = mockServices([project]);
  const registry = createRegistry();
  const invoke = (name: string, args: unknown = {}, p: ProjectHandle | null = project) =>
    registry.invoke(name, args, () => makeContext({ services, project: p }));
  return { project, invoke };
}

describe("off-board parts tools", () => {
  test("search finds a NEMA 17 and an OLED", async () => {
    const { invoke } = await setup();
    const motors = await invoke("parts_search", { query: "nema 17" });
    expect(motors.text).toContain("nema-17-stepper");
    const oled = await invoke("parts_search", { query: "oled", kind: "display" });
    expect((oled.json as { hits: Array<{ id: string }> }).hits.map((h) => h.id)).toContain("ssd1306-oled-128x64");
    await expect(invoke("parts_search", { query: "nema", kind: "display" })).resolves.toMatchObject({
      text: expect.stringContaining("No off-board parts"),
    });
  });

  test("add from catalog, custom line, list BOM, remove, and export CSV", async () => {
    const { project, invoke } = await setup();
    const added = await invoke("parts_add", { catalogId: "nema-17-stepper", qty: 2 });
    expect(added.text).toContain("M1");
    expect((added.json as { part: { ref: string; qty: number } }).part).toMatchObject({ ref: "M1", qty: 2 });

    const oled = await invoke("parts_add", { catalogId: "ssd1306-oled-128x64" });
    expect((oled.json as { part: { ref: string } }).part.ref).toBe("DS1");

    const custom = await invoke("parts_add", {
      name: "Custom heat sink",
      kind: "accessory",
      qty: 1,
      notes: "for the driver FET",
    });
    expect((custom.json as { part: { ref: string } }).part.ref).toBe("A1");

    await expect(invoke("parts_add", { catalogId: "nope" })).rejects.toMatchObject({ code: "not_found" });
    await expect(invoke("parts_add", { name: "x" })).rejects.toThrow(/catalogId|name and kind/);

    const listed = await invoke("parts_list");
    const bom = (listed.json as { bom: Array<{ refs: string[]; kind: string; source: string }> }).bom;
    expect(bom.map((l) => [l.source, l.kind, l.refs.join(" ")])).toEqual([
      ["pcb", "pcb", "R1"],
      ["offboard", "accessory", "A1"],
      ["offboard", "display", "DS1"],
      ["offboard", "motor", "M1"],
    ]);

    const off = await invoke("parts_list", { scope: "offboard" });
    expect((off.json as { parts: unknown[] }).parts).toHaveLength(3);

    const csv = await invoke("export_bom");
    expect(csv.text).toContain("1 electrical, 3 off-board");
    const text = await readFile(join(project.dir, "exports/bom.csv"), "utf8");
    expect(text).toContain("motor,offboard,M1,NEMA 17 stepper motor,2");
    expect(text).toContain("display,offboard,DS1");
    expect(text).toContain("pcb,pcb,R1,1k,1");

    await invoke("parts_remove", { ref: "A1" });
    const after = await invoke("parts_list", { scope: "offboard" });
    expect((after.json as { parts: Array<{ ref: string }> }).parts.map((p) => p.ref)).toEqual(["M1", "DS1"]);
    await expect(invoke("parts_remove", { ref: "Z9" })).rejects.toMatchObject({ code: "not_found" });
  });

  test("does not write off-board hardware into the electrical netlist", async () => {
    const { project, invoke } = await setup();
    await invoke("parts_add", { catalogId: "m3-screw-ph-8", qty: 8 });
    const netlist = JSON.parse(await readFile(join(project.dir, "circuit.netlist.json"), "utf8")) as {
      netlist: { components: Array<{ ref: string }> };
    };
    expect(netlist.netlist.components.map((c) => c.ref)).toEqual(["R1"]);
    const parts = JSON.parse(await readFile(join(project.dir, "project.parts.json"), "utf8")) as {
      parts: Array<{ ref: string; qty: number }>;
    };
    expect(parts.parts).toEqual([expect.objectContaining({ ref: "H1", qty: 8 })]);
  });
});
