import { expect, test } from "bun:test";
import { exportGerberPackage, gerberPackageFilename } from "./manufacturing-package";
import type { ToolRunState } from "./tools";

const done = (files: string[]): ToolRunState => ({ status: "done", result: { json: { files } } });
const base = { projectId: "p", sourceSha256: "a".repeat(64), filename: "io-gerbers.zip", isCurrent: () => true, onPhase: () => {} };

test("package keeps one captured member/source and sends only newly exported layer and drill names", async () => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const board = { sourceId: "io", manifestSha256: "b".repeat(64) };
  const result = await exportGerberPackage({ ...base, board, run: async (tool, args) => {
    calls.push({ tool, args });
    return done(tool === "export_gerbers" ? ["/project/boards/io/exports/gerbers/board-F_Cu.gbr"] : tool === "export_drill" ? ["/project/boards/io/exports/gerbers/board.drl"] : ["gerbers/board-F_Cu.gbr", "gerbers/board.drl"]);
  } });
  expect(calls.map(call => call.tool)).toEqual(["export_gerbers", "export_drill", "export_zip"]);
  expect(calls.every(call => call.args.board === board && call.args.expectedSourceSha256 === base.sourceSha256)).toBe(true);
  expect(calls[2]!.args.gerberFiles).toEqual(["board-F_Cu.gbr", "board.drl"]);
  expect(result.files).toHaveLength(2);
});

test("failed drill export never packages old saved drills and retains the actual failure", async () => {
  const calls: string[] = [];
  await expect(exportGerberPackage({ ...base, run: async tool => {
    calls.push(tool); return tool === "export_gerbers" ? done(["exports/gerbers/top.gtl"]) : { status: "failed", error: "PCB changed before export" };
  } })).rejects.toThrow("PCB changed before export");
  expect(calls).toEqual(["export_gerbers", "export_drill"]);
});

test("missing drills, mismatched archives and a changed project never produce a completed package", async () => {
  await expect(exportGerberPackage({ ...base, run: async tool => done(tool === "export_gerbers" ? ["exports/gerbers/top.gtl"] : []) })).rejects.toThrow("did not report a drill file");
  await expect(exportGerberPackage({ ...base, run: async tool => done(tool === "export_gerbers" ? ["exports/gerbers/top.gtl"] : tool === "export_drill" ? ["exports/gerbers/board.drl"] : ["gerbers/old.gtl"]) })).rejects.toThrow("ZIP contents do not match");
  let ran = false;
  await expect(exportGerberPackage({ ...base, isCurrent: () => false, run: async () => { ran = true; return done([]); } })).rejects.toThrow("Project changed");
  expect(ran).toBe(false);
  expect(gerberPackageFilename("I/O main · Rev H A18")).toBe("I-O-main-Rev-H-A18-gerbers.zip");
});
