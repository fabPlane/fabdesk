import { describe, expect, test } from "bun:test";
import { extractSpecs, findMcu } from "../src/specs";

describe("caption specs", () => {
  test("formats board size, layers, MCU and part count", () => {
    const specs = extractSpecs({
      name: "Pico Sensor",
      board: { layers: 2, widthMm: 50, heightMm: 30.5 },
      components: [
        { ref: "R1", value: "10k", footprint: "Resistor_SMD:R_0402" },
        { ref: "U1", value: "RP2040", footprint: "Package_QFN:QFN-56" },
        { ref: "C1", value: "100n", footprint: "Capacitor_SMD:C_0402" },
      ],
    });
    expect(specs.name).toBe("Pico Sensor");
    expect(specs.lines).toEqual(["50 MM × 30.5 MM", "2 LAYERS", "MCU RP2040", "3 PARTS"]);
  });

  test("prefers a U-prefixed MCU over a value mentioned in a connector", () => {
    expect(
      findMcu([
        { ref: "J1", value: "ESP32-DEVKIT", footprint: "Connector" },
        { ref: "U2", value: "STM32F103C8T6", footprint: "LQFP-48" },
      ]),
    ).toBe("STM32F103C8T6");
  });
});
