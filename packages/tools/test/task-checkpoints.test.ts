import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import { compareTaskCheckpoint, compareTaskPcb, listTaskCheckpoints } from "../src/task-checkpoints";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const track = (id: string, net: string, y = 0) => `(segment (start 0 ${y}) (end 3 ${y}) (width .2) (layer "F.Cu") (net "${net}") (uuid "${id}"))`;
const board = (tracks: string, net = "USB_DP", x = 0) => `(kicad_pcb (footprint "Header" (uuid "j5") (property "Reference" "J5") (at ${x} 0) (layer "F.Cu") (pad "1" smd rect (uuid "j5-1") (at 0 0) (size 1 1) (layers "F.Cu") (net "${net}"))) ${tracks})`;
async function harness(name: string) {
  const project = await tempProject(name), services = mockServices([project]);
  const registry = createRegistry(), factory = contextFactory(services, project);
  const call = (tool: string, args: Record<string, unknown>) => registry.invoke(tool, args, ref => factory({ def: registry.get(tool)!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
  return { project, services, call, registry };
}

test("task baseline exposes unrelated swap copper changes through product status despite broader operation selection", async () => {
  const { project, call, registry } = await harness("task-swap");
  const initial = board(track("usb", "USB_DP") + track("sd", "SD_DAT0"));
  await writeFile(join(project.dir, "board.kicad_pcb"), initial);
  const response = await call("project_checkpoint", { action: "retain", name: "before swap", reason: "explicit swap boundary", role: "baseline", scope: { nets: ["USB_DP"], references: ["J5", "J8"] } });
  const checkpoint = response.json as any;
  expect(checkpoint.validation).toEqual({ designChecksRun: false, taskAccepted: false });
  // This is a saved-native artifact edit, independent of how copper/sync/router generated it.
  await call("project_write_file", { path: "board.kicad_pcb", content: board(track("usb", "USB_DP", 1) + track("sd", "SD_DAT0", 2)) });
  const status = (await call("project_status", {})).json as any;
  expect(status.taskComparison.changeCount).toBe(2);
  expect(status.taskComparison.outsideScopeCount).toBe(1);
  expect(status.taskComparison.changedNets).toEqual(["SD_DAT0", "USB_DP"]);
  expect(status.taskComparison.changes.find((value: any) => value.nets.includes("SD_DAT0")).scope).toBe("outside");
  expect(registry.get("project_checkpoint")!.annotations.readOnlyHint).toBe(false);
  expect(registry.get("project_status")!.annotations.readOnlyHint).toBe(true);
  expect(await readFile(join(project.dir, ".fabdesk/task-checkpoints", checkpoint.id, "files/board.kicad_pcb"), "utf8")).toBe(initial);
  await call("project_checkpoint", { action: "retain", name: "later incomplete", reason: "keep experiment" });
  const persisted = await listTaskCheckpoints({ ...project });
  expect(persisted.length).toBe(2);
  expect((await compareTaskCheckpoint({ ...project }))!.checkpointId).toBe(checkpoint.id);
  await expect(call("project_checkpoint", { action: "retain", name: "widen", reason: "later operation", role: "baseline", scope: { nets: ["USB_DP", "SD_DAT0"] } })).rejects.toThrow("baseline already retained");
});

test("held-out fan fixture: scope does not expand from a header to unrelated control copper", async () => {
  const before = board(track("fan", "FAN_PWM") + track("control", "TEMP_SENSE"), "FAN_PWM");
  const after = board(track("fan", "FAN_PWM", 1) + track("control", "TEMP_SENSE", 2), "FAN_PWM", 5);
  const changes = compareTaskPcb(before, after, { nets: ["FAN_PWM"], references: ["J5"] });
  expect(changes.filter(value => value.scope === "outside").map(value => value.nets)).toEqual([["TEMP_SENSE"]]);
  expect(changes.find(value => value.category === "footprint")!.scope).toBe("inside");
  // An explicit changed pad-net membership (e.g. schematic sync) remains visible.
  const pad = compareTaskPcb(before, board(track("fan", "FAN_PWM") + track("control", "TEMP_SENSE"), "NEW_NET"), null).find(value => value.category === "pad")!;
  expect(pad.nets).toEqual(["FAN_PWM", "NEW_NET"]);
  expect(pad.scope).toBe("undeclared");
});

test("checkpoint retains child native files, shows byte-only schematic/rule changes, and detects tampered backups", async () => {
  const { project, call } = await harness("task-native");
  await mkdir(join(project.dir, "sheets"));
  await writeFile(join(project.dir, "sheets/child.kicad_sch"), "first");
  await writeFile(join(project.dir, "board.kicad_dru"), "rules");
  await writeFile(join(project.dir, "board.kicad_pcb"), board(track("usb", "USB_DP")));
  const checkpoint = (await call("project_checkpoint", { action: "retain", name: "native", reason: "before edits", role: "baseline" })).json as any;
  expect(checkpoint.files.some((file: any) => file.path === "sheets/child.kicad_sch")).toBe(true);
  await writeFile(join(project.dir, "sheets/child.kicad_sch"), "changed connectivity");
  const comparison = (await call("project_checkpoint", { action: "compare" })).json as any;
  expect(comparison.files.map((file: any) => file.path)).toEqual(["sheets/child.kicad_sch"]);
  expect(comparison.coverage.schematicConnectivity).toContain("unmeasured");
  await writeFile(join(project.dir, ".fabdesk/task-checkpoints", checkpoint.id, "files/board.kicad_dru"), "tampered");
  await expect(call("project_checkpoint", { action: "compare" })).rejects.toThrow("bytes no longer match");
});

test("foreign project identity and ambiguous anonymous objects fail instead of claiming preservation", async () => {
  const { project, call } = await harness("task-identity");
  await call("project_checkpoint", { action: "retain", name: "missing board", reason: "incomplete task", role: "baseline" });
  const comparison = (await call("project_checkpoint", { action: "compare" })).json as any;
  expect(comparison.coverage.pcbObjects).toContain("unavailable");
  await expect(listTaskCheckpoints({ ...project, id: "other" })).rejects.toThrow("identity mismatch");
  expect(() => compareTaskPcb('(kicad_pcb (segment (start 0 0)) (segment (start 0 0)))', '(kicad_pcb)', null)).toThrow("ambiguous");
});

test("same length translated tracks and changed arc midpoints are detected; net code renumbering is not", () => {
  expect(compareTaskPcb(board(track("x", "A")), board(track("x", "A", 2)), { nets: ["A"], references: [] }).length).toBe(1);
  expect(compareTaskPcb('(kicad_pcb (net 1 "A") (segment (start 0 0) (end 1 1) (net 1) (uuid "x")))', '(kicad_pcb (net 9 "A") (segment (net 9) (end 1 1) (start 0 0) (uuid "x")))', null)).toEqual([]);
  expect(compareTaskPcb('(kicad_pcb (arc (start 0 0) (mid 1 1) (end 2 0) (uuid "x")))', '(kicad_pcb (arc (start 0 0) (mid 1 2) (end 2 0) (uuid "x")))', null).length).toBe(1);
});

test("native input symlinks and checkpoint directory escapes are rejected", async () => {
  const { project, call } = await harness("task-symlink");
  await symlink("/etc/passwd", join(project.dir, "board.kicad_sch"));
  await expect(call("project_checkpoint", { action: "retain", name: "unsafe", reason: "test" })).rejects.toThrow("symlink");
});


test("KiCad 10.99 footprint and pad transform changes are measured", () => {
  const native = '(kicad_pcb (footprint "Header" (uuid "j2") (transform (translate 110 31) (rotate 90) (scale 1 1)) (property "Reference" "J2") (pad "1" smd rect (uuid "p1") (transform (translate 1 2) (rotate 0)) (net "PWM"))))';
  const shifted = native.replace("translate 110 31", "translate 111 31");
  const changes = compareTaskPcb(native, shifted, { nets: ["PWM"], references: ["J2"] });
  expect(changes.length).toBe(1);
  expect(changes[0]!.category).toBe("footprint");
  expect(compareTaskPcb(native, native.replace("translate 1 2", "translate 2 2"), null)[0]!.category).toBe("pad");
});

test("bounded comparison retains complete detail and hidden child native files", async () => {
  const { project, call } = await harness("task-bounded");
  await mkdir(join(project.dir, ".sheets"));
  await writeFile(join(project.dir, ".sheets/.child.kicad_sch"), "native child");
  await writeFile(join(project.dir, "board.kicad_pcb"), board(Array.from({ length: 35 }, (_, i) => track(`t${i}`, `N${i}`)).join("")));
  const checkpoint = (await call("project_checkpoint", { action: "retain", name: "bounded", reason: "retain all", role: "baseline", scope: { nets: [], references: [] } })).json as any;
  expect(checkpoint.files.some((file: any) => file.path === ".sheets/.child.kicad_sch")).toBe(true);
  await writeFile(join(project.dir, "board.kicad_pcb"), board(Array.from({ length: 35 }, (_, i) => track(`t${i}`, `N${i}`, 1)).join("")));
  const comparison = (await call("project_checkpoint", { action: "compare" })).json as any;
  expect(comparison.changeCount).toBe(35);
  expect(comparison.changes.length).toBe(30);
  expect(comparison.truncated).toBe(true);
  expect(comparison.changedNetCount).toBe(35);
  const full = JSON.parse(await readFile(join(project.dir, comparison.report), "utf8"));
  expect(full.changes.length).toBe(35);
  expect(full.truncated).toBe(false);
});

test("equivalent copper with replaced UUIDs is identity change, not new geometry", () => {
  const before = '(kicad_pcb (segment (start 0 0) (end 1 1) (width .2) (net "A") (uuid "old")))';
  const after = '(kicad_pcb (segment (start 0.0 0) (end 1 1) (width 0.2) (net "A") (uuid "new")))';
  const changes = compareTaskPcb(before, after, { nets: [], references: [] });
  expect(changes.length).toBe(1);
  expect(changes[0]!.kind).toBe("identity-only");
});
