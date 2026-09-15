import { describe, expect, test } from "bun:test";
import { prepareRegressionSymbols } from "../lib/regression-symbols";

describe("router regression schematic shim", () => {
  test("uses exact passive pins and removes nets that cannot be routed", () => {
    const prepared = prepareRegressionSymbols(
      {
        netlist: {
          components: [
            { ref: "U1", value: "QFN", footprint: "Package:QFN" },
            { ref: "R1", value: "10k", footprint: "Device:R" },
          ],
          nets: [
            { name: "route-me", nodes: [{ ref: "U1", pin: "29" }, { ref: "R1", pin: "1" }] },
            { name: "one-pad", nodes: [{ ref: "U1", pin: "3" }] },
          ],
        },
      },
      "/project/fabdesk-regression.kicad_sym",
    );

    expect(prepared.source.netlist?.nets?.map((net) => net.name)).toEqual(["route-me"]);
    expect(prepared.source.netlist?.components?.map((component) => component.libSource)).toEqual([
      { lib: "FabdeskRegression", part: "U1" },
      { lib: "FabdeskRegression", part: "R1" },
    ]);
    expect(prepared.source.libraries).toContainEqual({
      kind: "symbol",
      nickname: "FabdeskRegression",
      uri: "/project/fabdesk-regression.kicad_sym",
    });
    expect(prepared.library).toContain('(symbol "U1"');
    expect(prepared.library).toContain('(number "29"');
    expect(prepared.library).not.toContain('(number "3"');
    expect(prepared.library.match(/\(pin passive/g)).toHaveLength(2);
  });
});
