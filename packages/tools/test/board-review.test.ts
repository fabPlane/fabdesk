import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, type CoreServices } from "../src";
import { openReviewProject, reviewGate } from "@fabdesk/board-workflow";
import { readReviewGate } from "../src/board-state";
import { bomDirOf, writeBomMeta } from "../src/release-state";
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
  // the desktop's approval card: what the owner answers (owner.answer) and what was asked (owner.asked)
  const owner: { answer: "approve" | "deny" | "timeout" | "no-card"; asked: string[] } = { answer: "approve", asked: [] };
  const ctx = async () => {
    const c = await contextFactory(services, project)({ def, projectRef: undefined, signal: new AbortController().signal, progress: () => {} } as never);
    if (owner.answer === "no-card") return c;
    return { ...c, requestOwnerApproval: async ({ summary }: { summary: string }) => {
      owner.asked.push(summary);
      return { approved: owner.answer === "approve", requestId: `apr_${owner.asked.length}`, by: owner.answer === "timeout" ? "timeout" as const : "desktop" as const, at: new Date().toISOString() };
    } };
  };
  const call = async (args: object) => (def.handler as unknown as (a: object, c: unknown) => Promise<{ text: string; json?: Record<string, unknown> }>)(args, await ctx());
  return { project, call, owner };
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

  test("the BOM check reads board_release bom's decisions; a BOM of an earlier board is a must-fix, not trusted", async () => {
    const { project, call } = await setup();
    await mkdir(bomDirOf(project.dir), { recursive: true });
    await writeFile(join(bomDirOf(project.dir), "bom-decisions.json"), JSON.stringify({ lines: 1, placements: 1, summary: { UNRESOLVED: 1 }, records: [{ line: "L1", refs: ["U1"], value: "MCU", status: "UNRESOLVED", reason: "no LCSC" }] }));
    const sha = createHash("sha256").update(await readFile(join(project.dir, "board.kicad_pcb"))).digest("hex");
    await writeBomMeta(project.dir, { at: "t", boardSha256: sha, stem: "board", boards: 5, offline: true, summary: { UNRESOLVED: 1 }, lines: 1, placements: 1 });
    let run = await call({ action: "run", offline: true });
    let open = run.json?.["open"] as Array<{ id: string; severity: string; claim: string }>;
    expect(open.find((o) => o.claim.startsWith("UNRESOLVED L1"))?.severity).toBe("must-fix");
    await writeBomMeta(project.dir, { at: "t", boardSha256: "0".repeat(64), stem: "board", boards: 5, offline: true, summary: { UNRESOLVED: 1 }, lines: 1, placements: 1 });
    run = await call({ action: "run", offline: true });
    open = run.json?.["open"] as Array<{ id: string; severity: string; claim: string }>;
    expect(open.some((o) => o.claim.startsWith("UNRESOLVED L1"))).toBe(false);
    expect(open.find((o) => o.id === "L6:BOM:-:-:stale")?.severity).toBe("must-fix");
  });

  test("the saved gate covers dispositions, the run and the board; removing the runs clears it", async () => {
    const { project, call } = await setup();
    await writeFile(join(project.dir, "b.kicad_pcb"), PCB);
    await call({ action: "run", offline: true });
    await call({ action: "dispose", id: "*", state: "accept", by: "owner", reason: "bench", thirdSource: "bench log" });
    expect((await readReviewGate(project.dir)).state).toBe("pass");
    // a review of board.kicad_pcb never passes b.kicad_pcb, saved or live
    expect((await readReviewGate(project.dir, "b.kicad_pcb")).state).toBe("stale");
    expect((await reviewGate(await openReviewProject(project.dir, "b.kicad_pcb"))).state).toBe("stale");
    expect((await reviewGate(await openReviewProject(project.dir))).state).toBe("pass");
    // dispositions removed behind the gate's back: the saved pass is stale
    const disp = join(project.dir, ".fabdesk", "board", "review", "dispositions.json");
    const kept = await readFile(disp, "utf8");
    await rm(disp);
    expect((await readReviewGate(project.dir)).state).toBe("stale");
    await writeFile(disp, kept);
    expect((await readReviewGate(project.dir)).state).toBe("pass");
    // runs deleted: stale at once, and the next gate clears the record instead of keeping the old pass
    await rm(join(project.dir, ".fabdesk", "board", "review", "runs"), { recursive: true });
    expect((await readReviewGate(project.dir)).state).toBe("stale");
    expect((await call({ action: "gate" })).json?.["state"]).toBe("none");
    expect((await readReviewGate(project.dir)).state).toBe("none");
  });

  test("intent_init, intent_decide and intent: the owner's decision settles what it covers and the gate is recorded", async () => {
    const { project, call } = await setup();
    expect((await call({ action: "intent" })).text).toContain("intent_init");
    await expect(call({ action: "intent_decide", id: "D1", decision: "x" })).rejects.toThrow(/no intent/);
    const init = await call({ action: "intent_init" });
    expect(init.text).toContain("fill the goal");
    await expect(call({ action: "intent_init" })).rejects.toThrow(/exists/);
    await call({ action: "run", offline: true });
    await expect(call({ action: "intent_decide", id: "D1" })).rejects.toThrow(/needs decision/);
    const d = await call({ action: "intent_decide", id: "D1", decision: "the USB-C faces in on purpose", covers: ["L4:MOUTH:J1*"] });
    expect(d.text).toContain("recorded D1; it settles L4:MOUTH:J1*");
    expect(d.json?.["settles"]).toEqual(["L4:MOUTH:J1:-"]);
    expect((await call({ action: "intent" })).text).toContain("dec   D1");
    const g = (await readReviewGate(project.dir)) as { state: string };
    expect(g.state).toBe("open");
  });

  test("owner decisions need the owner's approval card: declined, unanswered or unavailable records nothing", async () => {
    const { call, owner } = await setup();
    await call({ action: "run", offline: true });
    for (const answer of ["deny", "timeout", "no-card"] as const) {
      owner.answer = answer;
      await expect(call({ action: "dispose", id: "*", state: "accept", by: "owner", reason: "bench", thirdSource: "bench log" })).rejects.toThrow(answer === "deny" ? /declined/ : answer === "timeout" ? /did not answer/ : /cannot show one/);
    }
    expect((await call({ action: "gate" })).json?.["state"]).toBe("open");
    owner.answer = "approve";
    const d = await call({ action: "dispose", id: "*", state: "accept", by: "owner", reason: "bench", thirdSource: "bench log" });
    expect(d.text).toContain("by owner (confirmed at the desktop)");
    expect(owner.asked.at(-1)).toContain("accept review finding *: bench");
    // an agent's own disposition never asks the owner
    const asked = owner.asked.length;
    await call({ action: "dispose", id: "*", state: "accept", by: "agent", reason: "datasheet", thirdSource: "datasheet p4" });
    expect(owner.asked).toHaveLength(asked);
    // preferences: confirmed on the card, then they delegate
    await call({ action: "intent_init" });
    const pref = await call({ action: "intent_delegate", delegate: ["questions"] });
    expect(pref.text).toContain("confirmed by the owner");
  });

  test("autopilot reviews, applies the fixes and ends with the owner's questions; try checks its inputs", async () => {
    const { project, call } = await setup();
    const r = await call({ action: "autopilot", offline: true });
    expect(r.text).toMatch(/\[1\/3\] review/);
    expect(r.text).toContain("[3/3] what is left");
    expect(r.text).toContain("NEEDS OWNER");
    expect((await readReviewGate(project.dir)).state).toBe("open");
    await expect(call({ action: "try" })).rejects.toThrow(/try needs plan/);
    await expect(call({ action: "try", plan: { id: "mine" }, ids: ["L9:NOPE:-:-"] })).rejects.toThrow(/not in the current review/);
    await expect(call({ action: "try", plan: "../nowhere.json" })).rejects.toThrow(/cannot read the plan/);
    await expect(call({ action: "try", plan: "[1]" })).rejects.toThrow(/cannot read the plan|JSON object/);
  });

  test("import_expert and pcb stay inside the project", async () => {
    const { project, call } = await setup();
    await call({ action: "run", offline: true });
    const outside = join(await mkdtemp(join(tmpdir(), "outside-")), "expert.json");
    await writeFile(outside, JSON.stringify({ reviewer: "x", findings: [] }));
    await expect(call({ action: "import_expert", file: outside })).rejects.toThrow(/outside the project/);
    await expect(call({ action: "import_expert", file: "../" + outside.split("/").slice(-2).join("/") })).rejects.toThrow(/outside the project|not found/);
    await writeFile(join(project.dir, "..", "elsewhere.kicad_pcb"), PCB);
    await expect(call({ action: "status", pcb: "../elsewhere.kicad_pcb" })).rejects.toThrow(/outside the project/);
  });
});
