import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gate } from "../../kicad/src/drc";
import { createRegistry } from "../src";
import { mockServices, tempProject, contextFactory } from "./mock-services";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
async function fixture() {
  const project = await tempProject("gate-freshness");
  await writeFile(join(project.dir, "board.kicad_pcb"), "saved PCB");
  await writeFile(join(project.dir, "board.kicad_sch"), "saved schematic");
  await mkdir(join(project.dir, "reports"));
  const drc = { violations: [{ severity: "warning", rule: "silk", signature: "silk:warning", description: "warning", items: [] }], unconnected: [], schematicParity: [], counts: { errors: 0, warnings: 1, unconnected: 0 }, pcbRevision: { sha256: sha("saved PCB") } };
  const saveDrc = () => writeFile(join(project.dir, "reports/drc.json"), JSON.stringify(drc));
  await saveDrc();
  const services = mockServices([project]); services.kicad.gate = gate;
  const reg = createRegistry(), factory = contextFactory(services, project);
  const call = (acceptWarnings = true, requireErc = false) => reg.invoke("verify_gate", { acceptWarnings, requireErc }, ref => factory({ def: reg.get("verify_gate")!, projectRef: ref, signal: new AbortController().signal, progress() {} }));
  return { project, drc, saveDrc, call };
}
test("gate rejects stale PCB before accepting warnings; a fresh check restores eligibility", async () => {
  const f = await fixture();
  await writeFile(join(f.project.dir, "board.kicad_pcb"), "edited PCB");
  const stale = await f.call();
  expect(stale.isError).toBe(true);
  expect(stale.text).toContain("DRC evidence is stale");
  expect(f.project.manifest().allowedDrcWarnings).toEqual([]);
  f.drc.pcbRevision.sha256 = sha("edited PCB"); await f.saveDrc();
  const fresh = await f.call();
  expect(fresh.isError).toBe(false);
  expect(f.project.manifest().allowedDrcWarnings).toEqual(["silk:warning"]);
});
for (const revision of [undefined, "bad-hash"]) test(`gate refuses missing or unsupported PCB receipt: ${revision}`, async () => {
  const f = await fixture();
  (f.drc as any).pcbRevision = revision ? { sha256: revision } : undefined; await f.saveDrc();
  const output = await f.call();
  expect(output.isError).toBe(true);
  expect(output.text).toContain("unverified");
  expect(f.project.manifest().allowedDrcWarnings).toEqual([]);
});
test("present but unmeasured ERC cannot produce a current pass or mutate warning baseline", async () => {
  const f = await fixture();
  await writeFile(join(f.project.dir, "reports/erc.json"), JSON.stringify({ violations: [], counts: { errors: 0, warnings: 0 } }));
  const output = await f.call(true, true);
  expect(output.isError).toBe(true);
  expect(output.text).toContain("ERC evidence is unverified");
  expect(f.project.manifest().allowedDrcWarnings).toEqual([]);
  expect(JSON.parse(await readFile(join(f.project.dir, "reports/gate.json"), "utf8")).pass).toBe(false);
});
