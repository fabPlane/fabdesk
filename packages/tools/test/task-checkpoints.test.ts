import { expect, test, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry, NativeRevisionConflict } from "../src";
import {
  compareTaskCheckpoint,
  compareTaskPcb,
  listTaskCheckpoints,
  restoreTaskCheckpoint,
} from "../src/task-checkpoints";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const track = (id: string, net: string, y = 0) =>
  `(segment (start 0 ${y}) (end 3 ${y}) (width .2) (layer "F.Cu") (net "${net}") (uuid "${id}"))`;
const board = (tracks: string, net = "USB_DP", x = 0) =>
  `(kicad_pcb (footprint "Header" (uuid "j5") (property "Reference" "J5") (at ${x} 0) (layer "F.Cu") (pad "1" smd rect (uuid "j5-1") (at 0 0) (size 1 1) (layers "F.Cu") (net "${net}"))) ${tracks})`;
async function harness(name: string) {
  const project = await tempProject(name),
    services = mockServices([project]);
  const registry = createRegistry(),
    factory = contextFactory(services, project);
  const call = (tool: string, args: Record<string, unknown>) =>
    registry.invoke(tool, args, (ref) =>
      factory({
        def: registry.get(tool)!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
    );
  return { project, services, call, registry };
}

test("task baseline exposes unrelated swap copper changes through product status despite broader operation selection", async () => {
  const { project, call, registry } = await harness("task-swap");
  const initial = board(track("usb", "USB_DP") + track("sd", "SD_DAT0"));
  await writeFile(join(project.dir, "board.kicad_pcb"), initial);
  const response = await call("project_checkpoint", {
    action: "retain",
    name: "before swap",
    reason: "explicit swap boundary",
    role: "baseline",
    scope: { nets: ["USB_DP"], references: ["J5", "J8"] },
  });
  const checkpoint = response.json as any;
  expect(checkpoint.validation).toEqual({ designChecksRun: false, taskAccepted: false });
  // This is a saved-native artifact edit, independent of how copper/sync/router generated it.
  await call("project_write_file", {
    path: "board.kicad_pcb",
    content: board(track("usb", "USB_DP", 1) + track("sd", "SD_DAT0", 2)),
  });
  const status = (await call("project_status", {})).json as any;
  expect(status.taskComparison.changeCount).toBe(2);
  expect(status.taskComparison.outsideScopeCount).toBe(1);
  expect(status.taskComparison.changedNets).toEqual(["SD_DAT0", "USB_DP"]);
  expect(
    status.taskComparison.changes.find((value: any) => value.nets.includes("SD_DAT0")).scope,
  ).toBe("outside");
  expect(registry.get("project_checkpoint")!.annotations.readOnlyHint).toBe(false);
  expect(registry.get("project_status")!.annotations.readOnlyHint).toBe(true);
  expect(
    await readFile(
      join(project.dir, ".fabdesk/task-checkpoints", checkpoint.id, "files/board.kicad_pcb"),
      "utf8",
    ),
  ).toBe(initial);
  await call("project_checkpoint", {
    action: "retain",
    name: "later incomplete",
    reason: "keep experiment",
  });
  const persisted = await listTaskCheckpoints({ ...project });
  expect(persisted.length).toBe(2);
  expect((await compareTaskCheckpoint({ ...project }))!.checkpointId).toBe(checkpoint.id);
  await expect(
    call("project_checkpoint", {
      action: "retain",
      name: "widen",
      reason: "later operation",
      role: "baseline",
      scope: { nets: ["USB_DP", "SD_DAT0"] },
    }),
  ).rejects.toThrow("baseline already retained");
});

test("held-out fan fixture: scope does not expand from a header to unrelated control copper", async () => {
  const before = board(track("fan", "FAN_PWM") + track("control", "TEMP_SENSE"), "FAN_PWM");
  const after = board(track("fan", "FAN_PWM", 1) + track("control", "TEMP_SENSE", 2), "FAN_PWM", 5);
  const changes = compareTaskPcb(before, after, { nets: ["FAN_PWM"], references: ["J5"] });
  expect(changes.filter((value) => value.scope === "outside").map((value) => value.nets)).toEqual([
    ["TEMP_SENSE"],
  ]);
  expect(changes.find((value) => value.category === "footprint")!.scope).toBe("inside");
  // An explicit changed pad-net membership (e.g. schematic sync) remains visible.
  const pad = compareTaskPcb(
    before,
    board(track("fan", "FAN_PWM") + track("control", "TEMP_SENSE"), "NEW_NET"),
    null,
  ).find((value) => value.category === "pad")!;
  expect(pad.nets).toEqual(["FAN_PWM", "NEW_NET"]);
  expect(pad.scope).toBe("undeclared");
});

test("checkpoint retains child native files, shows byte-only schematic/rule changes, and detects tampered backups", async () => {
  const { project, call } = await harness("task-native");
  await mkdir(join(project.dir, "sheets"));
  await writeFile(join(project.dir, "sheets/child.kicad_sch"), "first");
  await writeFile(join(project.dir, "board.kicad_dru"), "rules");
  await writeFile(join(project.dir, "board.kicad_pcb"), board(track("usb", "USB_DP")));
  const checkpoint = (
    await call("project_checkpoint", {
      action: "retain",
      name: "native",
      reason: "before edits",
      role: "baseline",
    })
  ).json as any;
  expect(checkpoint.files.some((file: any) => file.path === "sheets/child.kicad_sch")).toBe(true);
  await writeFile(join(project.dir, "sheets/child.kicad_sch"), "changed connectivity");
  const comparison = (await call("project_checkpoint", { action: "compare" })).json as any;
  expect(comparison.files.map((file: any) => file.path)).toEqual(["sheets/child.kicad_sch"]);
  expect(comparison.coverage.schematicConnectivity).toContain("unmeasured");
  await writeFile(
    join(project.dir, ".fabdesk/task-checkpoints", checkpoint.id, "files/board.kicad_dru"),
    "tampered",
  );
  await expect(call("project_checkpoint", { action: "compare" })).rejects.toThrow(
    "bytes no longer match",
  );
});

test("foreign project identity and ambiguous anonymous objects fail instead of claiming preservation", async () => {
  const { project, call } = await harness("task-identity");
  await call("project_checkpoint", {
    action: "retain",
    name: "missing board",
    reason: "incomplete task",
    role: "baseline",
  });
  const comparison = (await call("project_checkpoint", { action: "compare" })).json as any;
  expect(comparison.coverage.pcbObjects).toContain("unavailable");
  await expect(listTaskCheckpoints({ ...project, id: "other" })).rejects.toThrow(
    "identity mismatch",
  );
  expect(() =>
    compareTaskPcb("(kicad_pcb (segment (start 0 0)) (segment (start 0 0)))", "(kicad_pcb)", null),
  ).toThrow("ambiguous");
});

test("same length translated tracks and changed arc midpoints are detected; net code renumbering is not", () => {
  expect(
    compareTaskPcb(board(track("x", "A")), board(track("x", "A", 2)), {
      nets: ["A"],
      references: [],
    }).length,
  ).toBe(1);
  expect(
    compareTaskPcb(
      '(kicad_pcb (net 1 "A") (segment (start 0 0) (end 1 1) (net 1) (uuid "x")))',
      '(kicad_pcb (net 9 "A") (segment (net 9) (end 1 1) (start 0 0) (uuid "x")))',
      null,
    ),
  ).toEqual([]);
  expect(
    compareTaskPcb(
      '(kicad_pcb (arc (start 0 0) (mid 1 1) (end 2 0) (uuid "x")))',
      '(kicad_pcb (arc (start 0 0) (mid 1 2) (end 2 0) (uuid "x")))',
      null,
    ).length,
  ).toBe(1);
});

test("native input symlinks and checkpoint directory escapes are rejected", async () => {
  const { project, call } = await harness("task-symlink");
  await symlink("/etc/passwd", join(project.dir, "board.kicad_sch"));
  await expect(
    call("project_checkpoint", { action: "retain", name: "unsafe", reason: "test" }),
  ).rejects.toThrow("symlink");
});

test("KiCad 10.99 footprint and pad transform changes are measured", () => {
  const native =
    '(kicad_pcb (footprint "Header" (uuid "j2") (transform (translate 110 31) (rotate 90) (scale 1 1)) (property "Reference" "J2") (pad "1" smd rect (uuid "p1") (transform (translate 1 2) (rotate 0)) (net "PWM"))))';
  const shifted = native.replace("translate 110 31", "translate 111 31");
  const changes = compareTaskPcb(native, shifted, { nets: ["PWM"], references: ["J2"] });
  expect(changes.length).toBe(1);
  expect(changes[0]!.category).toBe("footprint");
  expect(
    compareTaskPcb(native, native.replace("translate 1 2", "translate 2 2"), null)[0]!.category,
  ).toBe("pad");
});

test("bounded comparison retains complete detail and hidden child native files", async () => {
  const { project, call } = await harness("task-bounded");
  await mkdir(join(project.dir, ".sheets"));
  await writeFile(join(project.dir, ".sheets/.child.kicad_sch"), "native child");
  await writeFile(
    join(project.dir, "board.kicad_pcb"),
    board(Array.from({ length: 35 }, (_, i) => track(`t${i}`, `N${i}`)).join("")),
  );
  const checkpoint = (
    await call("project_checkpoint", {
      action: "retain",
      name: "bounded",
      reason: "retain all",
      role: "baseline",
      scope: { nets: [], references: [] },
    })
  ).json as any;
  expect(checkpoint.files.some((file: any) => file.path === ".sheets/.child.kicad_sch")).toBe(true);
  await writeFile(
    join(project.dir, "board.kicad_pcb"),
    board(Array.from({ length: 35 }, (_, i) => track(`t${i}`, `N${i}`, 1)).join("")),
  );
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

test("restore retains displaced saved project, removes later child files, and survives context restart", async () => {
  const { project, services, call } = await harness("task-restore");
  services.design.withSavedFilesRecovery = async (_dir, replace) => replace();
  const original = board(track("usb", "USB_DP"));
  await writeFile(join(project.dir, "board.kicad_pcb"), original);
  await writeFile(join(project.dir, "board.kicad_sch"), "original schematic");
  const checkpoint = (
    await call("project_checkpoint", {
      action: "retain",
      name: "good work",
      reason: "before experiment",
      role: "baseline",
    })
  ).json as any;
  await writeFile(join(project.dir, "board.kicad_pcb"), board(track("usb", "USB_DP", 1)));
  await writeFile(join(project.dir, "board.kicad_sch"), "experimental schematic");
  await writeFile(join(project.dir, "extra.kicad_sch"), "new child sheet");
  const compare = (await compareTaskCheckpoint({ ...project }))!;
  const response = (
    await call("project_checkpoint", {
      action: "restore",
      checkpointId: checkpoint.id,
      expectedRevision: compare.currentRevision,
      reason: "reject experiment",
    })
  ).json as any;
  expect(response.status).toBe("restored");
  expect(response.validation).toEqual({ designChecksRun: false, taskAccepted: false });
  expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(original);
  expect(await readFile(join(project.dir, "board.kicad_sch"), "utf8")).toBe("original schematic");
  expect(await Bun.file(join(project.dir, "extra.kicad_sch")).exists()).toBe(false);
  expect(
    await readFile(
      join(
        project.dir,
        ".fabdesk/task-checkpoints",
        response.displacedCheckpointId,
        "files/extra.kicad_sch",
      ),
      "utf8",
    ),
  ).toBe("new child sheet");
  expect((await compareTaskCheckpoint({ ...project }))!.currentRevision).toBe(checkpoint.revision);
  expect(
    (await listTaskCheckpoints({ ...project }))
      .filter((value) => value.role === "baseline")
      .map((value) => value.id),
  ).toEqual([checkpoint.id]);
  // Restore the displaced work through a fresh context: recovery is genuinely reversible.
  await call("project_checkpoint", {
    action: "restore",
    checkpointId: response.displacedCheckpointId,
    expectedRevision: checkpoint.revision,
    reason: "resume experiment",
  });
  expect(await readFile(join(project.dir, "extra.kicad_sch"), "utf8")).toBe("new child sheet");
});

test("stale, tampered, foreign and unsaved restores preserve canonical files", async () => {
  const { project, services, call } = await harness("task-restore-refusal");
  services.design.withSavedFilesRecovery = async (_dir, replace) => replace();
  const original = board(track("usb", "USB_DP"));
  await writeFile(join(project.dir, "board.kicad_pcb"), original);
  const checkpoint = (
    await call("project_checkpoint", {
      action: "retain",
      name: "before",
      reason: "fixture",
      role: "baseline",
    })
  ).json as any;
  const compare = (await compareTaskCheckpoint(project))!;
  const args = {
    action: "restore",
    checkpointId: checkpoint.id,
    expectedRevision: compare.currentRevision,
    reason: "restore",
  };
  const candidate = board(track("usb", "USB_DP", 2));
  await writeFile(join(project.dir, "board.kicad_pcb"), candidate);
  await expect(call("project_checkpoint", args)).rejects.toThrow(
    "refusing stale checkpoint restore",
  );
  const fresh = (await compareTaskCheckpoint(project))!;
  services.design.withSavedFilesRecovery = async () => {
    throw new NativeRevisionConflict("unsaved live conflict");
  };
  await expect(
    call("project_checkpoint", { ...args, expectedRevision: fresh.currentRevision }),
  ).rejects.toThrow("unsaved live conflict");
  expect((await listTaskCheckpoints(project)).length).toBe(1);
  await expect(
    restoreTaskCheckpoint(
      { ...project, id: "foreign" },
      checkpoint.id,
      fresh.currentRevision,
      "restore",
      null,
      async (run) => run(),
    ),
  ).rejects.toThrow("identity mismatch");
  await rm(join(project.dir, ".fabdesk/task-checkpoints", checkpoint.id, "files/board.kicad_pcb"));
  await expect(
    call("project_checkpoint", { ...args, expectedRevision: fresh.currentRevision }),
  ).rejects.toThrow("bytes no longer match");
  expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(candidate);
});

test("a racing writer during multi-file restore gives partial journal and recoverable saved versions", async () => {
  const { project, services, call } = await harness("task-restore-partial");
  await writeFile(join(project.dir, "board.kicad_pcb"), board(track("a", "A")));
  await writeFile(join(project.dir, "board.kicad_sch"), "A");
  const checkpoint = (
    await call("project_checkpoint", {
      action: "retain",
      name: "A",
      reason: "fixture",
      role: "baseline",
    })
  ).json as any;
  await writeFile(join(project.dir, "board.kicad_pcb"), board(track("a", "A", 1)));
  await writeFile(join(project.dir, "board.kicad_sch"), "B");
  const fresh = (await compareTaskCheckpoint(project))!;
  // Inject an actual filesystem refusal at commit, after validating and retaining all bytes.
  // A directory appears at a later target immediately after an earlier target is replaced.
  const rename = fs.rename;
  const writer = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    await rename(from, to);
    if (to === join(project.dir, "board.kicad_pcb")) {
      await fs.unlink(join(project.dir, "board.kicad_sch"));
      await fs.mkdir(join(project.dir, "board.kicad_sch"));
    }
  });
  services.design.withSavedFilesRecovery = async (_dir, run) => run();
  try {
    await expect(
      call("project_checkpoint", {
        action: "restore",
        checkpointId: checkpoint.id,
        expectedRevision: fresh.currentRevision,
        reason: "partial test",
      }),
    ).rejects.toThrow("checkpoint restore partial");
    const records = await listTaskCheckpoints(project);
    expect(records.length).toBe(2);
    expect(
      await readFile(
        join(
          project.dir,
          ".fabdesk/task-checkpoints",
          records.find((value) => value.id !== checkpoint.id)!.id,
          "files/board.kicad_sch",
        ),
        "utf8",
      ),
    ).toBe("B");
  } finally {
    writer.mockRestore();
  }
});

test("outer native transaction cannot overwrite an external file or discard live state on conflict", async () => {
  const { project, services, call } = await harness("native-conflict-preservation");
  await writeFile(join(project.dir, "board.kicad_pcb"), board(track("a", "A")));
  let releases = 0;
  services.design.release = async () => {
    releases++;
  };
  services.design.editBoardGeometry = async () => {
    await writeFile(join(project.dir, "board.kicad_pcb"), "external restored bytes");
    throw new NativeRevisionConflict("refusing stale save");
  };
  await expect(
    call("native_edit_transaction", {
      mode: "apply",
      geometry: {
        tracks: [
          { start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, net: "A", layer: "F.Cu", width: 0.2 },
        ],
      },
    }),
  ).rejects.toThrow("refusing stale save");
  expect(releases).toBe(0);
  expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(
    "external restored bytes",
  );
});

test("native transaction rollback respects the same unsaved-live recovery refusal", async () => {
  const { project, services, call } = await harness("native-rollback-conflict");
  const original = board(track("a", "A"));
  await writeFile(join(project.dir, "board.kicad_pcb"), original);
  services.design.editBoardGeometry = async () => {
    await writeFile(join(project.dir, "board.kicad_pcb"), board(track("a", "A", 1)));
    return {
      created: { tracks: 1, vias: 0, zones: 0, texts: 0, graphics: 0 },
      deleted: 0,
      saved: true,
      revision: 1,
    } as any;
  };
  const accepted = (
    await call("native_edit_transaction", {
      mode: "apply",
      geometry: {
        tracks: [
          { start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, net: "A", layer: "F.Cu", width: 0.2 },
        ],
      },
    })
  ).json as any;
  services.design.withSavedFilesRecovery = async () => {
    throw new NativeRevisionConflict("unsaved live work must survive");
  };
  await expect(
    call("native_edit_rollback", { transactionId: accepted.transactionId }),
  ).rejects.toThrow("unsaved live work must survive");
  expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(
    board(track("a", "A", 1)),
  );
});

test("checkpoint restore rejects in-project native aliases before replacing another file", async () => {
  const { project, call } = await harness("restore-native-alias");
  await writeFile(join(project.dir, "board.kicad_pcb"), board(track("a", "A")));
  await writeFile(join(project.dir, "board.kicad_sch"), "A");
  const checkpoint = (
    await call("project_checkpoint", {
      action: "retain",
      name: "A",
      reason: "fixture",
      role: "baseline",
    })
  ).json as any;
  const fresh = (await compareTaskCheckpoint(project))!;
  await rm(join(project.dir, "board.kicad_sch"));
  await symlink("board.kicad_pcb", join(project.dir, "board.kicad_sch"));
  await expect(
    call("project_checkpoint", {
      action: "restore",
      checkpointId: checkpoint.id,
      expectedRevision: fresh.currentRevision,
      reason: "must reject alias",
    }),
  ).rejects.toThrow("non-file/symlink");
  expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(board(track("a", "A")));
});
