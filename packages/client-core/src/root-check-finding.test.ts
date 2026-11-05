import { expect, test } from "bun:test";
import { captureRootCheckFinding, rootCheckFindingRow } from "./root-check-finding";

const report = () => ({ pcbRevision: { sha256: "a".repeat(64), bytes: 5 }, violations: [{ description: "Short", items: [{ description: "Pad 1", pos: { x: 105.49, y: 100 } }] }] });
test("root finding captures a real report item without retaining mutable geometry", () => {
  const raw = report(), finding = captureRootCheckFinding("http://local", "p", raw, 0, 0);
  expect(finding).toMatchObject({ endpoint: "http://local", projectId: "p", sourceSha256: "a".repeat(64), point: { x: 105.49, y: 100 }, description: "Short", itemDescription: "Pad 1" });
  raw.violations[0]!.items[0]!.pos.x = 200;
  expect(finding?.point.x).toBe(105.49);
  expect(finding?.reportFingerprint).not.toBe(JSON.stringify(raw));
});
test("untracked, member, absent and invalid-coordinate findings cannot supply root markers", () => {
  expect(captureRootCheckFinding("http://local", "p", { violations: report().violations }, 0, 0)).toBeNull();
  expect(captureRootCheckFinding("http://local", "p", { ...report(), boardSource: { sourceId: "other" } }, 0, 0)).toBeNull();
  expect(captureRootCheckFinding("http://local", "p", report(), 9, 0)).toBeNull();
  const raw = report(); raw.violations[0]!.items[0]!.pos.x = Infinity;
  expect(captureRootCheckFinding("http://local", "p", raw, 0, 0)).toBeNull();
});

test("return navigation restores only the same report, endpoint and project", () => {
  const raw = report(), finding = captureRootCheckFinding("http://local", "p", raw, 0, 0);
  expect(rootCheckFindingRow("http://local", "p", raw, finding)).toBe(0);
  expect(rootCheckFindingRow("http://other", "p", raw, finding)).toBeNull();
  expect(rootCheckFindingRow("http://local", "other", raw, finding)).toBeNull();
  expect(rootCheckFindingRow("http://local", "p", { ...raw, pcbRevision: { sha256: "b".repeat(64), bytes: 5 } }, finding)).toBeNull();
  raw.violations[0]!.items[0]!.pos.x = 110;
  expect(rootCheckFindingRow("http://local", "p", raw, finding)).toBeNull();
});

test("duplicate indistinguishable rows cannot restore an arbitrary selection", () => {
  const raw = report(); raw.violations.push(structuredClone(raw.violations[0]!));
  const finding = captureRootCheckFinding("http://local", "p", raw, 0, 0);
  expect(rootCheckFindingRow("http://local", "p", raw, finding)).toBeNull();
  expect(rootCheckFindingRow("http://local", "p", raw, null)).toBeNull();
});
