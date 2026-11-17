import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "../src";
import { runTraceMaker, traceMakerKeepsViasOffPads, traceMakerRouted } from "../src/routers/tracemaker";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const board = (vias: string) => `(kicad_pcb (version 20250114) (net "N1") (net "N2")
	(footprint "Lib:R" (layer "F.Cu") (at 10 10 0) (property "Reference" "R1" (at 0 0))
		(pad "1" smd rect (at -1 0) (size 0.8 0.8) (layers "F.Cu" "F.Paste") (net "N1"))
		(pad "2" smd rect (at 1 0) (size 0.8 0.8) (layers "F.Cu" "F.Paste") (net "N2")))
	${vias}
)`;
const IN_PAD = `(via (at 11 10) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net "N2") (uuid "new-via"))`;

async function routeOnce(acceptance: unknown) {
  const project = await tempProject(`via-in-pad-${acceptance ? "allowed" : "avoid"}`);
  const pcb = join(project.dir, "board.kicad_pcb");
  const starting = board("");
  await writeFile(pcb, starting);
  await writeFile(join(project.dir, "board.kicad_pro"), "{}");
  const accPath = join(project.dir, ".fabdesk/board/requirements/acceptance.json");
  if (acceptance) {
    await mkdir(join(accPath, ".."), { recursive: true });
    await writeFile(accPath, JSON.stringify(acceptance));
  }
  const base = mockServices([project]);
  const services = mockServices([project], {
    design: {
      ...base.design,
      // Freerouting on the bridge: no via-in-pad option, so a via lands in R1.2
      route: async (dir) => {
        await writeFile(join(dir, "board.kicad_pcb"), board(IN_PAD));
        return {
          tracks: 0, vias: 1, claimedVias: 0, routed: 1, total: 1, trackLengthNm: 0, elapsedMs: 1, wallMs: 1, timedOut: false,
          message: "routed", unrouted: [], log: [],
          geometry: [{ kind: "via" as const, id: "new-via", layer: 3, net: 2, netName: "N2", points: [11, 10], width: 0.5 }],
        };
      },
    },
  });
  const registry = createRegistry();
  const factory = contextFactory(services, project);
  const call = (name: string, args: Record<string, unknown>) =>
    registry.invoke(name, args, (ref) => factory({ def: registry.get(name)!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
  const response = await call("route_run", { router: "freerouting", waitMs: 1000 });
  const run = services.routeRuns.get((response.json as any).run.id)!;
  return { project, pcb, starting, accPath, run, call };
}

test("route_run holds a Freerouting candidate that adds a via in a solder pad; route_apply waits for the policy", async () => {
  // a board-workflow project (requirements recorded) without a via-in-pad decision
  const { pcb, starting, accPath, run, call } = await routeOnce({ manufacturing_rules: {} });
  expect(run.result?.viaInPad?.vias).toEqual([{ net: "N2", x: 11, y: 10, lands: ["R1.2"] }]);
  expect(run.result?.viaInPad?.allowed).toBe(false);
  expect(run.application.state).toBe("manual");
  expect(run.application.reason).toContain("1 new via(s) in solder pads, not allowed");
  expect(run.result?.nextActions?.[0]).toContain("move the new vias out of the solder pads");
  expect(await readFile(pcb, "utf8")).toBe(starting); // not applied
  const status = await call("route_status", { runId: run.id });
  expect(status.text).toContain("N2 at (11, 10) in R1.2");
  await expect(call("route_apply", { runId: run.id, expectedPcbRevision: run.startingPcbRevision })).rejects.toThrow("manufacturing_rules.via_in_pad does not allow them");
  // the decision recorded afterwards lets the same candidate apply
  await mkdir(join(accPath, ".."), { recursive: true });
  await writeFile(accPath, JSON.stringify({ manufacturing_rules: { via_in_pad: { allow: true, basis: "fab quotes filled+capped vias" } } }));
  const applied = await call("route_apply", { runId: run.id, expectedPcbRevision: run.startingPcbRevision });
  expect((applied.json as any).state).toBe("applied");
});

test("a project without board-workflow requirements gets the via-in-pad report, not a hold", async () => {
  const { run } = await routeOnce(null);
  expect(run.result?.viaInPad?.vias).toEqual([{ net: "N2", x: 11, y: 10, lands: ["R1.2"] }]);
  expect(run.result?.viaInPad?.text).toContain("reported only");
  expect(run.application.state).toBe("applied");
});

test("route_run applies a candidate with a via in a pad when the acceptance allows via-in-pad, and says so", async () => {
  const { run } = await routeOnce({ manufacturing_rules: { via_in_pad: { allow: true, basis: "BGA escape, filled and capped" } } });
  expect(run.result?.viaInPad?.allowed).toBe(true);
  expect(run.result?.viaInPad?.text).toContain("allowed by manufacturing_rules.via_in_pad (BGA escape, filled and capped)");
  expect(run.application.state).toBe("applied");
});

test.skipIf(process.platform === "win32")("runTraceMaker keeps vias off pads only when asked and the build offers it; it reports TraceMaker's own count", async () => {
  expect(traceMakerRouted("pass 1\nrouted 41/44 connections, 12 tracks\n")).toEqual({ routed: 41, total: 44 });
  expect(traceMakerRouted("nothing")).toBeNull();
  const dir = await mkdtemp(join(tmpdir(), "tm-fake-"));
  const argsFile = join(dir, "args.txt");
  const fake = async (name: string, help: string) => {
    const bin = join(dir, name);
    // a fake TraceMaker: answers route --help, otherwise records its arguments and copies the board to -o
    await writeFile(
      bin,
      `#!/bin/sh\nif [ "$2" = "--help" ]; then printf '%s\\n' '${help}'; exit 0; fi\necho "$@" > '${argsFile}'\nout=""\nprev=""\nfor a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done\ncp "$2" "$out"\necho "routed 3/4 connections, 2 tracks"\nexit 3\n`,
    );
    await chmod(bin, 0o755);
    return bin;
  };
  const snap = join(dir, "snap");
  await mkdir(snap, { recursive: true });
  await writeFile(join(snap, "board.kicad_pcb"), board(""));
  const modern = await fake("tm-new", "  --keep-vias-off-pads  --vias-off-pads-below FLOAT");
  const kept = await runTraceMaker({ binary: modern, snapshotDir: snap, timeoutMs: 5000, keepViasOffPads: true });
  expect(await readFile(argsFile, "utf8")).toContain("--keep-vias-off-pads --vias-off-pads-below 1000");
  expect(kept.viasOffPads).toBe("kept off");
  expect([kept.routed, kept.total]).toEqual([3, 4]);
  await runTraceMaker({ binary: modern, snapshotDir: snap, timeoutMs: 5000 });
  expect(await readFile(argsFile, "utf8")).not.toContain("--keep-vias-off-pads");
  const old = await fake("tm-old", "  --via-in-pad");
  const r = await runTraceMaker({ binary: old, snapshotDir: snap, timeoutMs: 5000, keepViasOffPads: true });
  expect(await readFile(argsFile, "utf8")).not.toContain("--keep-vias-off-pads");
  expect(r.viasOffPads).toBe("not supported");
  expect(r.log.join("\n")).toContain("vias in pads are checked after routing");
});

test.skipIf(process.platform === "win32")("the TraceMaker help probe stops on abort, and an answer is not kept for an updated binary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tm-probe-"));
  const bin = join(dir, "tracemaker");
  // a build whose --help hangs
  await writeFile(bin, "#!/bin/sh\nsleep 30\n");
  await chmod(bin, 0o755);
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 50);
  const started = Date.now();
  expect(await traceMakerKeepsViasOffPads(bin, abort.signal)).toBe(false);
  expect(Date.now() - started).toBeLessThan(5_000);
  // the interrupted probe was not cached: a build that answers is asked again and believed
  await writeFile(bin, "#!/bin/sh\necho '--keep-vias-off-pads --vias-off-pads-below'\n");
  await chmod(bin, 0o755);
  expect(await traceMakerKeepsViasOffPads(bin)).toBe(true);
});
