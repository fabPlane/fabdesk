import { describe, expect, test } from "bun:test";
import { rankPartSearch, type PartSearchCandidate } from "./part-search-ranking";

const candidate = (
  libId: string,
  description = "",
  keywords: string[] = [],
): PartSearchCandidate => {
  const [nickname, ...name] = libId.split(":");
  return { libId, nickname: nickname!, name: name.join(":"), description, keywords };
};

describe("KiCad part search ranking", () => {
  test("ranks the four observed natural-language searches without suppressing alternatives", () => {
    const symbols = [
      candidate("Device:R", "Resistor", ["R", "res", "resistor"]),
      candidate("Device:Heater", "Heating element / resistor"),
      candidate("Device:LED", "Light emitting diode", ["LED", "diode"]),
      candidate("LED:APA102", "Serial RGB LED"),
      candidate("LED:APFA3010", "Vendor LED"),
      candidate("Connector_Generic:Conn_01x02", "Generic connector, single row, 01x02", [
        "connector",
      ]),
      candidate(
        "Connector_Generic_MountingPin:Conn_01x02_MountingPin",
        "Generic connector with mounting pin",
      ),
      candidate("Connector_Generic:Conn_2Rows-05Pins", "Generic connector, two rows"),
    ];
    const footprints = [
      candidate("LED_THT:LED_D5.0mm", "LED, diameter 5.0mm, 2 pins"),
      candidate("LED_THT:LED_D3.0mm_Horizontal_O5.0mm", "Horizontal LED"),
      candidate("Button_Switch_THT:SW_5mm", "Through-hole button"),
      candidate("Vendor_LED:ABC_5mm", "Vendor through-hole LED"),
    ];

    expect(rankPartSearch("resistor", symbols)[0]?.libId).toBe("Device:R");
    expect(rankPartSearch("LED", symbols).map((hit) => hit.libId)).toEqual([
      "Device:LED",
      "LED:APA102",
      "LED:APFA3010",
    ]);
    expect(rankPartSearch("2 pin connector generic", symbols)[0]?.libId).toBe(
      "Connector_Generic:Conn_01x02",
    );
    expect(rankPartSearch("LED 5mm THT", footprints)[0]?.libId).toBe("LED_THT:LED_D5.0mm");
    expect(rankPartSearch("mounting pin connector", symbols)[0]?.libId).toBe(
      "Connector_Generic_MountingPin:Conn_01x02_MountingPin",
    );
  });

  test("keeps exact identity strongest and complete name coverage above incidental prose", () => {
    const candidates = [
      candidate("Vendor:ExactTarget", "unrelated"),
      candidate("ExactTarget:Other", "ExactTarget"),
      candidate("Other:Partial", "ExactTarget plus incidental description words"),
    ];
    expect(rankPartSearch("Vendor:ExactTarget", candidates)[0]?.libId).toBe("Vendor:ExactTarget");
    expect(rankPartSearch("ExactTarget", candidates)[0]?.libId).toBe("Vendor:ExactTarget");

    const coverage = [
      candidate("Package:Socket_1x02_P5.08mm", "two pin terminal package"),
      candidate("Package:Socket_1x03_P5.08mm", "mentions two pin terminal in passing"),
      candidate("Package:Socket_1x02_P5.00mm", "two pin terminal"),
    ];
    expect(rankPartSearch("socket 2 pin 5.08mm", coverage)[0]?.libId).toBe(
      "Package:Socket_1x02_P5.08mm",
    );
  });

  test("retains metadata-only vendor discovery and stable ordering", () => {
    const candidates = [
      candidate("Vendor_B:ZX900", "Precision ultraviolet sensor"),
      candidate("Vendor_A:QX800", "Ultraviolet detector"),
      candidate("Generic:Sensor", "Ambient light sensor"),
    ];
    const forward = rankPartSearch("ultraviolet", candidates).map((hit) => hit.libId);
    const reverse = rankPartSearch("ultraviolet", [...candidates].reverse()).map(
      (hit) => hit.libId,
    );
    expect(forward).toEqual(["Vendor_A:QX800", "Vendor_B:ZX900"]);
    expect(reverse).toEqual(forward);
  });
});
