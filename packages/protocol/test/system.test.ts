import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildSystemDiagram,
  classifyPart,
  designGraphFromNetlist,
  designGraphFromPcb,
  designGraphFromSchematic,
  designGraphFromSources,
  formatSystemSummary,
  notableNet,
  padNetName,
  type NetlistFile,
} from "../src";

const boards = join(import.meta.dir, "../../../vendor/fab_pcb/e2e/fixtures/boards");

const mcuBoard = (): NetlistFile => ({
  netlist: {
    components: [
      { ref: "U1", value: "ESP32-WROOM-32", footprint: "RF_Module:ESP32-WROOM-32" },
      { ref: "U2", value: "AMS1117-3.3", footprint: "Package_TO_SOT_SMD:SOT-223-3_TabPin2" },
      { ref: "U3", value: "BME280", footprint: "Package_LGA:Bosch_LGA-8_3x3mm_P0.8mm" },
      { ref: "J1", value: "USB_C", footprint: "Connector_USB:USB_C_Receptacle" },
      { ref: "Y1", value: "40MHz", footprint: "Crystal:Crystal_SMD" },
      { ref: "R1", value: "10k", footprint: "Resistor_SMD:R_0402_1005Metric" },
      { ref: "C1", value: "100nF", footprint: "Capacitor_SMD:C_0402_1005Metric" },
      { ref: "C2", value: "10uF", footprint: "Capacitor_SMD:C_0805_2012Metric" },
    ],
    nets: [
      { name: "3V3", nodes: [{ ref: "U2", pin: "2" }, { ref: "U1", pin: "2" }, { ref: "U3", pin: "8" }, { ref: "C1", pin: "1" }, { ref: "C2", pin: "1" }] },
      { name: "GND", nodes: [{ ref: "U2", pin: "1" }, { ref: "U1", pin: "1" }, { ref: "U3", pin: "1" }, { ref: "J1", pin: "A1" }, { ref: "C1", pin: "2" }, { ref: "C2", pin: "2" }] },
      { name: "VIN", nodes: [{ ref: "J1", pin: "A4" }, { ref: "U2", pin: "3" }] },
      { name: "SDA", nodes: [{ ref: "U1", pin: "10" }, { ref: "U3", pin: "3" }, { ref: "R1", pin: "1" }] },
      { name: "SCL", nodes: [{ ref: "U1", pin: "11" }, { ref: "U3", pin: "4" }] },
      { name: "USB_D+", nodes: [{ ref: "J1", pin: "A6" }, { ref: "U1", pin: "20" }] },
      { name: "USB_D-", nodes: [{ ref: "J1", pin: "A7" }, { ref: "U1", pin: "19" }] },
      { name: "XTAL1", nodes: [{ ref: "Y1", pin: "1" }, { ref: "U1", pin: "15" }] },
    ],
  },
});

describe("system classification", () => {
  test("classifies MCU, regulator, sensor, USB and crystal", () => {
    expect(classifyPart({ ref: "U1", value: "ESP32-WROOM-32", footprint: "" }).kind).toBe("mcu");
    expect(classifyPart({ ref: "U2", value: "AMS1117-3.3", footprint: "" }).kind).toBe("power");
    expect(classifyPart({ ref: "U3", value: "BME280", footprint: "" }).kind).toBe("sensors");
    expect(classifyPart({ ref: "J1", value: "USB_C", footprint: "Connector_USB:USB_C" }).kind).toBe("io");
    expect(classifyPart({ ref: "Y1", value: "40MHz", footprint: "Crystal" }).role).toBe("clock");
    expect(classifyPart({ ref: "#PWR01", value: "GND", footprint: "" }).role).toBe("ignored");
  });

  test("labels power rails and buses, and skips GND", () => {
    expect(notableNet("+3V3")).toEqual({ kind: "power", label: "3.3V" });
    expect(notableNet("VIN")).toEqual({ kind: "power", label: "VIN" });
    expect(notableNet("SDA")).toEqual({ kind: "bus", label: "I2C" });
    expect(notableNet("USB_D+")).toEqual({ kind: "bus", label: "USB" });
    expect(notableNet("pic_sockets/VCC_PIC")).toEqual({ kind: "power", label: "VCC_PIC" });
    expect(notableNet("/VPP{slash}MCLR")).toEqual({ kind: "net", label: "VPP/MCLR" });
    expect(notableNet("GND")).toBeNull();
    expect(notableNet("unconnected-(U1-Pad2)")).toBeNull();
  });

  test("reads pad nets with and without a numeric id", () => {
    expect(padNetName(["net", "4", "+5V"])).toBe("+5V");
    expect(padNetName(["net", "VCC"])).toBe("VCC");
    expect(padNetName(["net", "0", ""])).toBe("");
  });
});

describe("synthetic board grouping", () => {
  test("groups a MCU board into power, processor, sensor and USB blocks with labelled edges", () => {
    const diagram = buildSystemDiagram(designGraphFromNetlist(mcuBoard()));
    const names = diagram.blocks.map((b) => b.name);
    expect(names.some((n) => /ESP32/i.test(n))).toBe(true);
    expect(names.some((n) => /1117|Power/i.test(n))).toBe(true);
    expect(names.some((n) => /BME280|Sensor/i.test(n))).toBe(true);
    expect(names.some((n) => /USB|Connector/i.test(n))).toBe(true);
    const mcu = diagram.blocks.find((b) => b.kind === "mcu");
    expect(mcu?.parts.some((p) => p.ref === "Y1")).toBe(true);
    const labels = diagram.edges.flatMap((e) => e.labels);
    expect(labels).toContain("3.3V");
    expect(labels).toContain("I2C");
    expect(labels).toContain("USB");
    expect(diagram.blocks.every((b) => b.w > 0 && b.h > 0)).toBe(true);
    const summary = formatSystemSummary(diagram);
    expect(summary).toContain("System blocks:");
    expect(summary).toContain("Connections:");
  });
});

describe("example boards", () => {
  test("StickHub groups the USB hub, connectors and voltage rails", async () => {
    const pcb = await readFile(join(boards, "stickhub/StickHub.kicad_pcb"), "utf8");
    const sch = await readFile(join(boards, "stickhub/StickHub.kicad_sch"), "utf8");
    const diagram = buildSystemDiagram(designGraphFromSources({ pcbText: pcb, schematics: [{ name: "StickHub", text: sch }] }));
    expect(diagram.blocks.length).toBeGreaterThanOrEqual(2);
    const hub = diagram.blocks.find((b) => b.parts.some((p) => p.ref === "U1"));
    expect(hub).toBeDefined();
    expect(hub!.kind === "mcu" || /XR22417|USB/i.test(hub!.name)).toBe(true);
    const power = diagram.blocks.find((b) => b.kind === "power");
    expect(power?.keyParts.some((p) => p.ref === "U2")).toBe(true);
    const io = diagram.blocks.find((b) => b.kind === "io");
    expect(io?.parts.some((p) => p.ref.startsWith("J"))).toBe(true);
    const labels = diagram.edges.flatMap((e) => e.labels);
    expect(labels.some((l) => /5V|3\.3V|1\.8V|USB|VIN/i.test(l))).toBe(true);
    expect(diagram.width).toBeGreaterThan(200);
    expect(diagram.blocks.every((a, i) => diagram.blocks.every((b, j) => i === j || a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y || a.x !== b.x))).toBe(true);
  });

  test("PIC programmer uses the pic_sockets sheet and a power regulator", async () => {
    const pcb = await readFile(join(boards, "pic_programmer/pic_programmer.kicad_pcb"), "utf8");
    const root = await readFile(join(boards, "pic_programmer/pic_programmer.kicad_sch"), "utf8");
    const sockets = await readFile(join(boards, "pic_programmer/pic_sockets.kicad_sch"), "utf8");
    const graph = designGraphFromSources({
      pcbText: pcb,
      schematics: [
        { name: "pic_programmer", text: root },
        { name: "pic_sockets", text: sockets },
      ],
    });
    expect(designGraphFromSchematic(root).sheets.some((s) => /pic_sockets/i.test(s.name) || /pic_sockets/i.test(s.file ?? ""))).toBe(true);
    expect(designGraphFromPcb(pcb).parts.some((p) => /pic_sockets/i.test(p.sheet ?? ""))).toBe(true);
    const diagram = buildSystemDiagram(graph);
    expect(diagram.blocks.some((b) => b.source === "sheet" && /socket/i.test(b.name))).toBe(true);
    expect(diagram.blocks.some((b) => b.kind === "power" || b.parts.some((p) => /7805|LT1373/i.test(p.value)))).toBe(true);
    expect(diagram.blocks.some((b) => b.kind === "io" || b.parts.some((p) => p.ref.startsWith("J") || /DB9/i.test(p.value)))).toBe(true);
    const labels = diagram.edges.flatMap((e) => e.labels);
    expect(labels.some((l) => /VCC|5V|VIN|VPP|UART|USB/i.test(l))).toBe(true);
  });
});
