import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NetlistFile } from "@fabdesk/protocol";
import { createRegistry } from "../src";
import { escapedNetNames } from "../src/tools/core";
import { DEMO_NETLIST, contextFactory, mockServices, tempProject } from "./mock-services";

/** Builds a project whose only net carries a KiCad brace escape, with or without board rules. */
async function buildWithBraces(name: string, board: NetlistFile["board"]) {
  const project = await tempProject(name);
  await writeFile(
    join(project.dir, "circuit.netlist.json"),
    JSON.stringify({
      ...DEMO_NETLIST,
      ...(board ? { board } : {}),
      netlist: {
        ...DEMO_NETLIST.netlist,
        nets: [{ name: "Net-(J2-CD{slash}DAT3)", nodes: [{ ref: "R1", pin: "1" }] }],
      },
    }),
  );
  const base = mockServices([project]);
  let compiled = false;
  const services = mockServices([project], {
    design: {
      ...base.design,
      build: async (opts) => {
        compiled = true;
        return base.design.build(opts);
      },
    },
  });
  const reg = createRegistry();
  const factory = contextFactory(services, project);
  const res = await reg.invoke("circuit_build", {}, (ref) =>
    factory({
      def: reg.get("circuit_build")!,
      projectRef: ref,
      signal: new AbortController().signal,
      progress: () => {},
    }),
  );
  const report = (await Bun.file(join(project.dir, "reports/build.json")).json()) as {
    ok: boolean;
    errors: Array<{ type?: string }>;
    warnings: Array<{ type?: string }>;
  };
  return { res, report, compiled };
}

describe("circuit_build and net names", () => {
  test("escapedNetNames finds KiCad's brace escapes", () => {
    const file = {
      ...DEMO_NETLIST,
      netlist: {
        ...DEMO_NETLIST.netlist,
        nets: [
          { name: "GND", nodes: [] },
          { name: "Net-(J2-CD{slash}DAT3)", nodes: [] },
          { name: "A{colon}B", nodes: [] },
        ],
      },
    };
    expect(escapedNetNames(file)).toEqual(["Net-(J2-CD{slash}DAT3)", "A{colon}B"]);
  });

  test("with board rules the build refuses them before the design server sees the netlist", async () => {
    const { res, report, compiled } = await buildWithBraces("braces-rules", {
      widthMm: 20,
      heightMm: 20,
      rules: { clearanceMm: 0.15 },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("net_name_escape");
    expect(res.text).toContain("Net-(J2-CD{slash}DAT3)");
    expect(compiled).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.errors[0]?.type).toBe("net_name_escape");
  });

  test("without rules the build goes ahead and warns", async () => {
    const { res, report, compiled } = await buildWithBraces("braces-no-rules", {
      widthMm: 20,
      heightMm: 20,
    });
    expect(compiled).toBe(true);
    expect(res.isError).toBe(false);
    expect(res.text).toContain("net_name_escape");
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.warnings[0]?.type).toBe("net_name_escape");
  });
});
