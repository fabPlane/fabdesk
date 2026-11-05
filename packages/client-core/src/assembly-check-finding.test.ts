import { expect, test } from "bun:test";
import { ProjectBoardSources } from "@fabdesk/protocol";
import { assemblyCheckFindingRow, assemblyCheckFindingOwned, assemblyFindingPreviewMatches, captureAssemblyCheckFinding } from "./assembly-check-finding";
import { sha256Blob } from "./pcb-preview-revision";
const hash = "b".repeat(64), manifest = "a".repeat(64);
function fixture() {
  const source = { id: "io", name: "I/O", location: "project", directory: "boards/io" };
  const data = ProjectBoardSources.parse({ projectId: "p", mode: "assembly", manifestSha256: manifest, editing: "explicit-source-tools", observedAt: "2026-10-28T00:00:00Z", assembly: { contract: "fabplane.assembly.v1", sources: [source], instances: [{ id: "left", name: "Left", sourceId: "io" }, { id: "right", name: "Right", sourceId: "io" }], connections: [] }, sources: [{ source, status: "available", pcbSha256: hash }] });
  const board = { sourceId: "io", manifestSha256: manifest };
  const report = { boardSource: { ...board, projectId: "p" }, pcbRevision: { sha256: hash, bytes: 12 }, violations: [{ description: "Clearance", items: [{ description: "Track", pos: { x: 107, y: 100 } }, { description: "No location" }] }] };
  return { data, snapshot: { board, projectId: "p", sourceSha256: hash, state: "source-unchanged" as const, report } };
}
test("finding captures actual native coordinates and preserves an owned shared physical instance", () => {
  const { data, snapshot } = fixture();
  const finding = captureAssemblyCheckFinding(data, snapshot, 0, 0, { ...snapshot.board, projectId: "p", instanceId: "right" })!;
  expect(finding.selection.instanceId).toBe("right"); expect(finding.point).toEqual({ x: 107, y: 100 });
  expect(assemblyCheckFindingOwned(data, finding)).toBe(true);
  snapshot.report.violations[0]!.items[0]!.pos!.x = 999;
  expect(finding.point.x).toBe(107);
  data.sources[0]!.pcbSha256 = "c".repeat(64);
  expect(assemblyCheckFindingOwned(data, finding)).toBe(false);
});
test("old, mismatched, missing and nonfinite finding locations never navigate", () => {
  const { data, snapshot } = fixture();
  expect(captureAssemblyCheckFinding(data, { ...snapshot, state: "source-changed" }, 0, 0)).toBeNull();
  expect(captureAssemblyCheckFinding(data, { ...snapshot, projectId: "other" }, 0, 0)).toBeNull();
  expect(captureAssemblyCheckFinding({ ...data, manifestSha256: "c".repeat(64) }, snapshot, 0, 0)).toBeNull();
  expect(captureAssemblyCheckFinding(data, snapshot, 0, 1)).toBeNull();
  for (const x of [NaN, Infinity, -Infinity]) { snapshot.report.violations[0]!.items[0]!.pos!.x = x; expect(captureAssemblyCheckFinding(data, snapshot, 0, 0)).toBeNull(); }
  snapshot.report.violations[0]!.items[0]!.pos!.x = 107;
  snapshot.report.boardSource.sourceId = "other";
  expect(captureAssemblyCheckFinding(data, snapshot, 0, 0)).toBeNull();
});
test("marker requires stamped native coordinates, matching source receipt and the exact displayed SVG bytes", async () => {
  const svg = '<svg data-fabplane-coordinate-system="kicad-pcb-mm-v1" viewBox="95 90 25 25"></svg>';
  const receipt = { contract: "fabplane.pcb-preview-revision.v1", source: "board.kicad_pcb", artifact: "renders/pcb.svg", sourceSha256: hash, artifactSha256: await sha256Blob(new Blob([svg])), generatedAt: "2026-10-28T00:00:00Z" };
  expect(await assemblyFindingPreviewMatches(svg, JSON.stringify(receipt), hash)).toBe(true);
  expect(await assemblyFindingPreviewMatches(svg + " ", JSON.stringify(receipt), hash)).toBe(false);
  expect(await assemblyFindingPreviewMatches(svg, JSON.stringify(receipt), "c".repeat(64))).toBe(false);
  expect(await assemblyFindingPreviewMatches(svg.replace('data-fabplane-coordinate-system', 'unverified'), JSON.stringify(receipt), hash)).toBe(false);
  expect(await assemblyFindingPreviewMatches(svg, "bad", hash)).toBe(false);
});

test("return navigation rejects changed reports and owners while exact indexes disambiguate identical findings", () => {
  const { data, snapshot } = fixture();
  const finding = captureAssemblyCheckFinding(data, snapshot, 0, 0)!;
  expect(assemblyCheckFindingRow(data, snapshot, finding)).toBe(0);
  expect(assemblyCheckFindingRow(data, { ...snapshot, state: "source-changed" }, finding)).toBeNull();
  expect(assemblyCheckFindingRow({ ...data, projectId: "other" }, snapshot, finding)).toBeNull();
  expect(assemblyCheckFindingRow(data, snapshot, { ...finding, reportFingerprint: "" })).toBeNull();
  snapshot.report.violations[0]!.description = "Changed report";
  expect(assemblyCheckFindingRow(data, snapshot, finding)).toBeNull();
  snapshot.report.violations[0]!.description = "Clearance";
  snapshot.report.violations.push(structuredClone(snapshot.report.violations[0]!));
  const ambiguous = captureAssemblyCheckFinding(data, snapshot, 0, 0)!;
  expect(assemblyCheckFindingRow(data, snapshot, ambiguous)).toBe(0);
  const second = captureAssemblyCheckFinding(data, snapshot, 1, 0)!;
  expect(assemblyCheckFindingRow(data, snapshot, second)).toBe(1);
  const { reportRowIndex: _row, reportItemIndex: _item, ...legacy } = ambiguous;
  expect(assemblyCheckFindingRow(data, snapshot, legacy)).toBeNull();
});

test("return indexes cannot bypass report ownership or point identity", () => {
  const { data, snapshot } = fixture(), finding = captureAssemblyCheckFinding(data, snapshot, 0, 0)!;
  for (const reportRowIndex of [-1, 0.5, NaN, Infinity, 99]) expect(assemblyCheckFindingRow(data, snapshot, { ...finding, reportRowIndex })).toBeNull();
  for (const reportItemIndex of [-1, 0.5, NaN, Infinity, 1, 99]) expect(assemblyCheckFindingRow(data, snapshot, { ...finding, reportItemIndex })).toBeNull();
  expect(assemblyCheckFindingRow(data, snapshot, { ...finding, point: { x: 108, y: 100 } })).toBeNull();
  expect(assemblyCheckFindingRow(data, snapshot, { ...finding, itemDescription: "Another track" })).toBeNull();
  const { reportItemIndex: _item, ...partial } = finding;
  expect(assemblyCheckFindingRow(data, snapshot, partial)).toBeNull();
});
