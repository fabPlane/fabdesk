import { expect, test } from "bun:test";
import { preflight } from "../pilot-preflight";
const arm = () => ({ capturedAt: "2026-11-17T00:00:00Z", sourceCommit: "a".repeat(40), commonFixCommits: ["b".repeat(40)], backend: { sourceCommit: "c".repeat(40), artifactSha256: "d".repeat(64) }, model: "actual-model", effort: "high", timeLimitSeconds: 1200, window: { width: 1280, height: 900, zoom: 1, scale: 1 }, effective: { instructions: "full instructions", skillCatalog: "explicit identical catalog", plugins: "[]", mcpEndpoints: "[]", settings: "{}", checkoutPath: "/main" }, readiness: { baseline: true, freshInstall: true, compileOverride: true, stalePcbGate: true, relocatedDesktopReopen: true } });
function pair() { return { contract: "fabdesk.pilot-preflight.v1", order: "pr-first", main: arm(), pr: arm(), allowedDifferences: [] as Array<{ key: string; main: string; pr: string; reason: string }>, frozen: { briefSha256: "e".repeat(64), graderSha256: "f".repeat(64), fixturesSha256: "0".repeat(64), plotOptions: { layers: "production" } } }; }
test("captures exact full input hashes and allows only documented path/tool differences", () => {
  const p = pair(); p.pr.effective.checkoutPath = "/pr";
  expect(preflight(p).ready).toBe(false);
  p.allowedDifferences.push({ key: "checkoutPath", main: "/main", pr: "/pr", reason: "isolated checkout" });
  const r = preflight(p); expect(r.ready).toBe(true); expect(r.fullHashes.main).not.toBe(r.fullHashes.pr); expect(r.normalizedHashes.main).toBe(r.normalizedHashes.pr);
  p.pr.effective.instructions += " hidden user skill";
  expect(preflight(p).failures).toContain("effective input mismatch instructions");
});
test("readiness and backend/model/common fixes cannot be exempted", () => {
  const p = pair(); p.main.readiness.baseline = false; p.pr.backend.sourceCommit = "9".repeat(40); p.pr.model = "other"; p.pr.commonFixCommits = ["8".repeat(40)];
  const r = preflight(p); expect(r.ready).toBe(false); expect(r.failures).toContain("main: readiness baseline incomplete"); expect(r.failures).toContain("mismatched backend"); expect(r.failures).toContain("mismatched model"); expect(r.failures).toContain("mismatched commonFixCommits");
});
test("rejects missing captures, broad exemptions and unused exemptions", () => {
  const p = pair(); p.pr.effective.skillCatalog = "different";
  p.allowedDifferences.push({ key: "skillCatalog", main: p.main.effective.skillCatalog, pr: "different", reason: "not allowed" });
  expect(preflight(p).failures).toContain("forbidden exemption skillCatalog");
  p.allowedDifferences = [{ key: "checkoutPath", main: "/wrong", pr: "/pr", reason: "stale exemption" }];
  p.main.effective.settings = "";
  expect(preflight(p).failures).toContain("unused or mismatched exemption checkoutPath"); expect(preflight(p).failures).toContain("main: missing captured settings");
});
