import { expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findKicadCli, runDrc } from "@fabdesk/kicad";
import { adoptBoard } from "./workflow-adopt";

// This fixture uses the pilot's KiCad 10.99 format. Explicitly select a compatible CLI;
// do not silently test against an older system binary or rewrite the scored artifacts.
const path = process.env["FABDESK_ADOPT_TEST_KICAD_CLI"];
const fixtures = join(import.meta.dir, "fixtures/adoption-stale-fill");
test.skipIf(!path)("adoption persists new zone fills and checks clean without a DRC refill, including a no-op adoption", async () => {
  const cli = await findKicadCli(path);
  if (!cli) throw Error("Configured adoption test CLI is unavailable");
  const dir = await mkdtemp(join(tmpdir(), "adopt-fill-regression-"));
  try {
    const target = join(dir, "board.kicad_pcb"), candidate = join(dir, "candidate.kicad_pcb");
    await copyFile(join(fixtures, "before.kicad_pcb"), target);
    await copyFile(join(fixtures, "candidate.kicad_pcb"), candidate);
    await copyFile(join(fixtures, "board.kicad_pro"), join(dir, "board.kicad_pro"));
    // The candidate itself contains old fill; it only scored clean with an in-memory refill.
    const stale = await runDrc(cli, { board: candidate, outFile: join(dir, "stale.json"), severity: "project", refillZones: false });
    expect(stale.counts.errors).toBeGreaterThan(0);
    const result = await adoptBoard({ target, candidate, cli });
    expect(result.zoneRefill).toEqual({ refilled: true });
    expect(result.residual).toEqual({ removed: {}, added: {}, changed: {} });
    const checked = await runDrc(cli, { board: target, outFile: join(dir, "saved.json"), severity: "project", refillZones: false });
    expect(checked.counts.errors).toBe(0); expect(checked.counts.unconnected).toBe(0);
    // Same item geometry, stale cached fill again: an empty item delta must still refill/save.
    await copyFile(candidate, target);
    const noOp = await adoptBoard({ target, candidate, cli });
    expect(noOp.delta).toEqual({ removed: {}, added: {}, changed: {} });
    expect(noOp.zoneRefill).toEqual({ refilled: true });
    expect((await runDrc(cli, { board: target, outFile: join(dir, "no-op.json"), severity: "project", refillZones: false })).counts.errors).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 120_000);
