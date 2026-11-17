import { describe, expect, test } from "bun:test";
import { parseLibraryTable, rowsToRestore } from "./project-library-tables";

const bundled = (name: string, uri = `/opt/libs/${name}.pretty`) =>
  `\t(lib (name "${name}") (type "KiCad") (uri "${uri}") (options "") (descr "Bundled KiCad footprint library"))`;
const table = (...rows: string[]) => `(fp_lib_table\n\t(version 7)\n${rows.join("\n")}\n)\n`;

describe("project library tables", () => {
  test("parses quoted, flagged and escaped rows", () => {
    const rows = parseLibraryTable(
      table(
        bundled("Resistor_SMD"),
        `\t(lib (name "Pilot") (type "KiCad") (uri "\${KIPRJMOD}/footprints/Pilot.pretty") (options "") (descr "a \\"quoted\\" note") (disabled) (hidden))`,
        `\t(lib (name Legacy)(type KiCad)(uri /x/Legacy.pretty)(options "")(descr ""))`,
      ),
    );
    expect(rows.map((r) => r.name)).toEqual(["Resistor_SMD", "Pilot", "Legacy"]);
    expect(rows[1]).toMatchObject({ uri: "${KIPRJMOD}/footprints/Pilot.pretty", descr: 'a "quoted" note', disabled: true, hidden: true });
    expect(parseLibraryTable("not a table")).toEqual([]);
  });

  test("restores project rows a table save dropped or overwrote, never stale bundled rows", () => {
    const custom = `\t(lib (name "Pilot") (type "KiCad") (uri "\${KIPRJMOD}/footprints/Pilot.pretty") (options "") (descr ""))`;
    const override = `\t(lib (name "Sensor_Humidity") (type "KiCad") (uri "\${KIPRJMOD}/Sensor_Humidity.pretty") (options "") (descr "project copy"))`;
    const before = parseLibraryTable(table(bundled("Resistor_SMD", "/old/Resistor_SMD.pretty"), custom, override));
    // KiCad rewrote the table from memory: the custom row is gone, the override replaced, and the
    // bundled row re-pointed at the current install.
    const after = parseLibraryTable(table(bundled("Resistor_SMD"), bundled("Sensor_Humidity")));
    expect(rowsToRestore(before, after).map((r) => r.name)).toEqual(["Pilot", "Sensor_Humidity"]);
    expect(rowsToRestore(before, before)).toEqual([]);
    expect(rowsToRestore(before, null).map((r) => r.name)).toEqual(["Pilot", "Sensor_Humidity"]);
    expect(rowsToRestore(null, after)).toEqual([]);
  });
});
