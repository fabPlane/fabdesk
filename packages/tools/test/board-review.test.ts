import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, type CoreServices } from "../src";
import { readReviewGate } from "../src/board-state";
import { ResourceGovernor, setGovernor } from "../src/resources";
import { contextFactory, mockServices, tempProject } from "./mock-services";

// a kicad-cli that writes what the review reads: netlist XML, ERC/DRC JSON, a render
const SCRIPT = `#!/bin/bash
out=""; prev=""
for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done
case "$1 $2 $3" in
  "sch export netlist") cat > "$out" <<'XML'
<export><components>
<comp ref="J1"><value>USB</value><footprint>F:x</footprint><libsource lib="Connector" part="USB_C" description="d"/></comp>
<comp ref="U1"><value>MCU</value><footprint>F:x</footprint><libsource lib="MCU" part="X" description="d"/></comp>
</components><nets>
<net code="1" name="SIG"><node ref="J1" pin="1" pinfunction="1" pintype="passive"/><node ref="U1" pin="3" pinfunction="IO1" pintype="bidirectional"/></net>
</nets></export>
XML
  ;;
  "sch erc --format") echo '{"sheets":[{"violations":[]}]}' > "$out" ;;
  "pcb drc --format") echo '{"violations":[],"unconnected_items":[],"schematic_parity":[]}' > "$out" ;;
  "pcb render -o") echo png > "$out" ;;
esac
exit 0
`;

const PCB = `(kicad_pcb (version 20250114)
	(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
	(gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts"))
	(footprint "Lib:J1" (layer "F.Cu") (at 2 15)
		(property "Reference" "J1" (at 0 0)) (property "Value" "USB" (at 0 0))
		(fp_rect (start -3 -4) (end 3 4) (layer "F.CrtYd"))
		(pad "1" smd rect (at -1.5 0) (size 0.6 0.6) (layers "F.Cu") (net "SIG")))
	(footprint "Lib:U1" (layer "F.Cu") (at 20 20)
		(property "Reference" "U1" (at 0 0)) (property "Value" "MCU" (at 0 0))
		(pad "3" smd rect (at 0 0) (size 0.6 0.6) (layers "F.Cu") (net "SIG")))
)`;

let cli = "";
beforeAll(async () => {
  const d = await mkdtemp(join(tmpdir(), "fake-kicad-"));
  cli = join(d, "kicad-cli");
  await writeFile(cli, SCRIPT);
  await chmod(cli, 0o755);
  process.env["FABDESK_FETCH_CACHE"] = join(d, "cache");
  setGovernor(new ResourceGovernor(async () => ({ memTotalGiB: 32, memAvailableGiB: 24, swapUsedGiB: 0, load1: 0, cpus: 8, disk: [] })));
});
afterAll(() => setGovernor(null));

async function setup() {
  const project = await tempProject("review");
  await writeFile(join(project.dir, "board.kicad_pcb"), PCB);
  await writeFile(join(project.dir, "board.kicad_sch"), "(kicad_sch)");
  const base = mockServices([project]);
  const services: CoreServices = { ...base, kicad: { ...base.kicad, resolveCli: async () => ({ path: cli, version: "fake" }) } };
  const def = createRegistry().get("board_review")!;
  const ctx = () => contextFactory(services, project)({ def, projectRef: undefined, signal: new AbortController().signal, progress: () => {} } as never);
  const call = async (args: object) => (def.handler as unknown as (a: object, c: unknown) => Promise<{ text: string; json?: Record<string, unknown> }>)(args, await ctx());
  return { project, call };
}

describe("board_review", () => {
  test("is a board-toolset tool with the five actions and an underscore name", () => {
    const def = createRegistry().get("board_review")!;
    expect(def.toolset).toBe("board");
    expect(def.name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  test("run -> gate -> dispose -> pass is recorded for the project's status; an edit makes it stale", async () => {
    const { project, call } = await setup();
    const none = await call({ action: "gate" });
    expect(none.json?.["exit"]).toBe(1);
    expect((await readReviewGate(project.dir)).state).toBe("none");
    const run = await call({ action: "run", offline: true });
    expect(run.text).toContain("Review review:");
    expect(run.text).toContain("mouth");
    const open = run.json?.["open"] as Array<{ id: string; severity: string }>;
    expect(open.some((o) => o.severity === "must-fix")).toBe(true);
    expect((await readReviewGate(project.dir)).state).toBe("open");
    const status = await call({ action: "status" });
    expect(status.text).toContain("current");
    await expect(call({ action: "dispose", id: "L*" })).rejects.toThrow(/needs state/);
    const d = await call({ action: "dispose", id: "*", state: "accept", by: "owner", reason: "looked at each on the bench", thirdSource: "bench log" });
    expect((d.json?.["disposed"] as string[]).length).toBeGreaterThan(1);
    expect((await readReviewGate(project.dir)).state).toBe("pass");
    await writeFile(join(project.dir, "board.kicad_pcb"), PCB + "\n");
    expect((await readReviewGate(project.dir)).state).toBe("stale");
    expect((await call({ action: "gate" })).json?.["exit"]).toBe(1);
  });

  test("fix lists proposals; import_expert reads the file", async () => {
    const { project, call } = await setup();
    await call({ action: "run", offline: true });
    const fix = await call({ action: "fix" });
    expect(fix.text).toContain("open:");
    expect(fix.text).toContain("NEEDS OWNER");
    const file = join(project.dir, "expert.json");
    await writeFile(file, JSON.stringify({ reviewer: "fresh", findings: [{ severity: "QUESTION", ref: "U1", claim: "no reset circuit" }] }));
    const imp = await call({ action: "import_expert", file: "expert.json" });
    expect(imp.text).toContain("imported 1 expert findings");
    expect(JSON.parse(await readFile(join(project.dir, ".fabdesk", "board", "review-gate.json"), "utf8")).state).toBe("open");
  });

  test("a partial run leaves the gate alone", async () => {
    const { project, call } = await setup();
    await call({ action: "run", offline: true, checks: ["identity", "netlist"] });
    expect((await readReviewGate(project.dir)).state).toBe("none");
  });
});
