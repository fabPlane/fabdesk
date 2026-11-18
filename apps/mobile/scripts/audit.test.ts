import { expect, test } from "bun:test";
import { assessAudit } from "./audit";
const known = {
  id: 1247710, url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
  title: "picomatch vulnerable to ReDoS through single-branch repeated extglobs",
  vulnerable_versions: "<=4.0.7", severity: "high",
};
test("accepts this advisory only after patch verification", () => {
  expect(assessAudit({ picomatch: [known] }, 1, () => 4)).toBe(4);
  expect(() => assessAudit({ picomatch: [known] }, 1, () => { throw new Error("unpatched copy"); })).toThrow("unpatched");
});
test("keeps other packages and new picomatch advisories fatal", () => {
  for (const report of [
    { other: [known] },
    { picomatch: [known, { ...known, id: 99, url: "https://example.com/new" }] },
    { picomatch: [{ ...known, vulnerable_versions: "<=4.0.8" }] },
    { picomatch: [{ ...known, title: "Different vulnerability" }] },
  ]) expect(() => assessAudit(report, 1, () => 4)).toThrow("Unmitigated");
});
test("fails closed on command errors or malformed reports", () => {
  for (const report of [null, [], { picomatch: null }, { picomatch: [null] }]) {
    expect(() => assessAudit(report, 1, () => 4)).toThrow();
  }
  expect(() => assessAudit({}, 1, () => 4)).toThrow("without findings");
  expect(() => assessAudit({}, 2, () => 4)).toThrow("command failed");
  expect(assessAudit({}, 0, () => 4)).toBe(4);
});
