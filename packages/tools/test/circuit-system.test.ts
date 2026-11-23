import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

test("circuit_system groups a MCU netlist into labelled blocks", async () => {
  const project = await tempProject("system");
  await writeFile(
    join(project.dir, "circuit.netlist.json"),
    JSON.stringify({
      netlist: {
        components: [
          { ref: "U1", value: "ESP32-WROOM-32", footprint: "RF_Module:ESP32-WROOM-32" },
          { ref: "U2", value: "AMS1117-3.3", footprint: "Package_TO_SOT_SMD:SOT-223-3_TabPin2" },
          { ref: "J1", value: "USB_C", footprint: "Connector_USB:USB_C_Receptacle" },
        ],
        nets: [
          { name: "3V3", nodes: [{ ref: "U2", pin: "2" }, { ref: "U1", pin: "2" }] },
          { name: "USB_D+", nodes: [{ ref: "J1", pin: "A6" }, { ref: "U1", pin: "20" }] },
        ],
      },
    }),
  );
  const reg = createRegistry();
  const out = await reg.invoke("circuit_system", { project: project.id }, (ref) =>
    contextFactory(mockServices([project]), project)({
      def: reg.get("circuit_system")!,
      projectRef: ref,
      signal: new AbortController().signal,
      progress: () => {},
    }),
  );
  expect(out.text).toContain("System blocks:");
  expect(out.text).toContain("Connections:");
  const json = out.json as { blocks: Array<{ kind: string }>; edges: Array<{ labels: string[] }> };
  expect(json.blocks.some((block) => block.kind === "mcu")).toBe(true);
  expect(json.blocks.some((block) => block.kind === "power")).toBe(true);
  expect(json.edges.flatMap((edge) => edge.labels).some((label) => /3\.3V|USB/i.test(label))).toBe(true);
});
