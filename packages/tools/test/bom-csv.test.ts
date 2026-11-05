import { expect, test } from "bun:test";
import { nativeBomComponents } from "../src/bom-csv";
const header = "Reference,Value,Footprint,MPN,Manufacturer,QUANTITY,DNP,EXCLUDE_FROM_BOM,EXCLUDE_FROM_BOARD\n";
test("native BOM preserves quoted part metadata and excludes DNP, excluded BOM and schematic-only parts", () => {
  const rows = 'R1,"1k, 1%",Resistor_THT:R,"M""PN","Maker\nWorks",1,,,\nR2,10k,R,,,1,yes,,\nR3,10k,R,,,1,,1,\nR4,10k,R,,,1,,,true\n';
  expect(nativeBomComponents(header + rows)).toEqual([{ ref: "R1", value: "1k, 1%", footprint: "Resistor_THT:R", fields: { MPN: 'M"PN', Manufacturer: "Maker\nWorks" } }]);
});
test("quantities require explicit unique native references instead of invented reference ranges", () => {
  expect(nativeBomComponents(header + '"R1,R2",1k,R,,,2,,,\n').map(component => component.ref)).toEqual(["R1", "R2"]);
  expect(() => nativeBomComponents(header + 'R1-R3,1k,R,,,3,,,\n')).toThrow("quantity");
  expect(() => nativeBomComponents(header + 'R1,1k,R,,,1,,,\nR1,1k,R,,,1,,,\n')).toThrow("repeats reference");
});
test("malformed or unsupported exports are not interpreted as an empty valid BOM", () => {
  for (const csv of ["", "Reference,Value\nR1,1k\n", header + 'R1,"bad,R,,,1,,,\n', header + 'R1,1k\n', header + 'R1,1k,R,,,1,unknown,,\n']) expect(() => nativeBomComponents(csv)).toThrow();
  expect(nativeBomComponents(header)).toEqual([]);
});
