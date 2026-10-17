import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Opt in with an unpacked package and a native seed. Actual MCP, core routing,
// KiCad and both engines are used; no mocked DesignService or model is involved.
const packageRoot = process.env["FABDESK_ROUTE_REGRESSION_PACKAGE"];
const seed = process.env["FABDESK_ROUTE_REGRESSION_SEED"];
for (const mode of ["saved", "unsaved"]) {
  test.skipIf(!packageRoot || !seed)(
    `packaged route_run after ${mode} edit preserves native ownership`,
    async () => {
      const out = await mkdtemp(join(tmpdir(), "fabdesk-packaged-route-regression-"));
      const label = `route-${mode}`;
      const proc = Bun.spawn(
        [
          "bun",
          join(import.meta.dir, "fixtures/packaged-route-recovery.ts"),
          packageRoot!,
          label,
          seed!,
          out,
          mode,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [exit, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const result = JSON.parse(await readFile(join(out, label, "results.json"), "utf8"));
      expect({ exit, verdict: result.verdict }, `${stdout}\n${stderr}\nEvidence: ${out}`).toEqual({
        exit: 0,
        verdict: "pass",
      });
      expect(result.cases.map((c: any) => ({ router: c.router, candidate: c.candidate }))).toEqual([
        { router: "freerouting", candidate: true },
        { router: "fab_router", candidate: true },
      ]);
      if (mode === "unsaved")
        expect(result.cases.every((c: any) => c.unsavedProtection === "pass")).toBe(true);
    },
    300_000,
  );
}
