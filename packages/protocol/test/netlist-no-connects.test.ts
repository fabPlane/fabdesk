import { expect, test } from "bun:test";
import { z } from "zod/v4";
import { NetlistFile } from "../src/fp-pcb";
test("compiler noConnects survive parsing and appear in JSON schema", () => {
  const noConnects = [{ ref: "U1", pin: "8" }];
  expect(NetlistFile.parse({ netlist: { components: [], nets: [], noConnects } }).netlist).toHaveProperty("noConnects", noConnects);
  expect(z.toJSONSchema(NetlistFile).properties?.netlist).toHaveProperty("properties.noConnects.items.properties.pin.type", "string");
});
