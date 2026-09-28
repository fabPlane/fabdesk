import { describe, expect, test } from "bun:test";
import {
  importKicadNetlist,
  parseSexpr,
  sanitizeNetName,
  uniqueNetNames,
} from "../import-kicad-netlist";

const NET = `(export (version "E")
  (design (source "/x/pcbgolf.kicad_sch") (tool "Eeschema 10.99.0"))
  (components
    (comp (ref "R1") (value "10k") (footprint "pcbgolf:0402-R")
      (fields (field (name "MPN") "RC0402FR-0710KL") (field (name "Footprint") "pcbgolf:0402-R") (field (name "Datasheet")))
      (libsource (lib "pcbgolf") (part "RESISTOR") (description "")))
    (comp (ref "J2") (value "MICRO_SD") (footprint "pcbgolf:0472192001"))
    (comp (ref "C6") (value "DNP") (footprint "pcbgolf:0402-C") (property (name "dnp")))
    (comp (ref "X1") (value "no-footprint") (footprint "")))
  (nets
    (net (code "1") (name "GND") (node (ref "R1") (pin "2") (pintype "passive")) (node (ref "J2") (pin "G1")) (node (ref "C6") (pin "2")))
    (net (code "2") (name "Net-(J2-CD{slash}DAT3)") (node (ref "R1") (pin "1")) (node (ref "J2") (pin "9")))
    (net (code "3") (name "ONLY_DNP") (node (ref "C6") (pin "1")) (node (ref "J2") (pin "1")))))`;

describe("importKicadNetlist", () => {
  test("components, fields, nets and the escape rewrite", () => {
    const { file, summary } = importKicadNetlist(NET, {
      libraries: [{ nickname: "pcbgolf", uri: "${KIPRJMOD}/pcbgolf.pretty" }],
      board: { widthMm: 70, heightMm: 55 },
    });
    expect(file.netlist.components).toEqual([
      {
        ref: "R1",
        value: "10k",
        footprint: "pcbgolf:0402-R",
        fields: { MPN: "RC0402FR-0710KL" },
        libSource: { lib: "pcbgolf", part: "RESISTOR" },
      },
      { ref: "J2", value: "MICRO_SD", footprint: "pcbgolf:0472192001" },
    ]);
    expect(file.netlist.nets).toEqual([
      {
        name: "GND",
        code: 1,
        nodes: [
          { ref: "R1", pin: "2" },
          { ref: "J2", pin: "G1" },
        ],
      },
      {
        name: "Net-(J2-CD_DAT3)",
        code: 2,
        nodes: [
          { ref: "R1", pin: "1" },
          { ref: "J2", pin: "9" },
        ],
      },
    ]);
    expect(file.netlist.design).toEqual({
      source: "/x/pcbgolf.kicad_sch",
      tool: "Eeschema 10.99.0",
    });
    expect(file.board).toEqual({ widthMm: 70, heightMm: 55 });
    expect(file.libraries).toEqual([
      { kind: "footprint", nickname: "pcbgolf", uri: "${KIPRJMOD}/pcbgolf.pretty" },
    ]);
    expect(summary).toEqual({
      components: 2,
      nets: 2,
      nodes: 4,
      dropped: { dnp: ["C6"], noFootprint: ["X1"], singleNodeNets: ["ONLY_DNP"] },
      renamed: [{ from: "Net-(J2-CD{slash}DAT3)", to: "Net-(J2-CD_DAT3)" }],
    });
  });

  test("--keep-dnp keeps the part and its nets", () => {
    const { file, summary } = importKicadNetlist(NET, { keepDnp: true });
    expect(file.netlist.components.map((c) => c.ref)).toEqual(["R1", "J2", "C6"]);
    expect(summary.dropped.singleNodeNets).toEqual([]);
    expect(file.netlist.nets[2]?.nodes).toEqual([
      { ref: "C6", pin: "1" },
      { ref: "J2", pin: "1" },
    ]);
  });

  test("the reader handles quoted strings with escapes", () => {
    expect(parseSexpr('(a "b \\"c\\"" (d e))')).toEqual(["a", 'b "c"', ["d", "e"]]);
    expect(sanitizeNetName("A{slash}B{colon}C")).toBe("A_B_C");
  });

  test("leftover braces are rewritten too", () => {
    expect(sanitizeNetName("CD{x-1}DAT3")).toBe("CD_x-1_DAT3");
    expect(sanitizeNetName("A}B{")).toBe("A_B_");
  });

  test("a rewrite never merges with an existing net", () => {
    expect(
      uniqueNetNames(["Net-(J2-CD{slash}DAT3)", "Net-(J2-CD_DAT3)", "A{slash}B", "A{colon}B"]),
    ).toEqual(["Net-(J2-CD_DAT3)_2", "Net-(J2-CD_DAT3)", "A_B", "A_B_2"]);
    expect(uniqueNetNames(["X{slash}Y", "X_Y", "X_Y_2"])).toEqual(["X_Y_3", "X_Y", "X_Y_2"]);
  });

  test("the import keeps colliding nets apart and reports the rename", () => {
    const text = NET.replace(
      '(net (code "3") (name "ONLY_DNP")',
      '(net (code "4") (name "Net-(J2-CD_DAT3)") (node (ref "R1") (pin "2")) (node (ref "J2") (pin "3")))\n    (net (code "3") (name "ONLY_DNP")',
    );
    const { file, summary } = importKicadNetlist(text);
    expect(file.netlist.nets.map((n) => n.name)).toEqual([
      "GND",
      "Net-(J2-CD_DAT3)_2",
      "Net-(J2-CD_DAT3)",
    ]);
    expect(summary.renamed).toEqual([{ from: "Net-(J2-CD{slash}DAT3)", to: "Net-(J2-CD_DAT3)_2" }]);
  });
});
