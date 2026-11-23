/**
 * Workflow measurement harnesses (dev script; not part of the app or the agent's tools):
 *
 *   bun packages/board-workflow/scripts/bench.ts edit-tasks NAME PROJECT_DIR OUT_DIR [--stem S] [--fixed RX] [--root DIR]
 *       the edit suite's plans for one board (rules, not hand picks); PROJECT_DIR must be onboarded (requirements)
 *   bun packages/board-workflow/scripts/bench.ts edit-run PLAN.json OUT_DIR [--heldout] [--root DIR] [--kicad-cli P] [--krt DIR]
 *       one edit task through the edit stage (runEdit full: impact, apply, last-mile repair, A1-A9 proof, churn guard),
 *       timed, written as editbench's OUT_DIR/result.json; the plan's project (relative to --root, default the current
 *       folder) is copied to OUT_DIR/project first. Without --krt only the repair's finish runs, on no router.
 *   bun packages/board-workflow/scripts/bench.ts edit-table RESULTS_DIR... [--md FILE]
 *       results across boards, tasks, repeats and tool versions (every result.json below the folders)
 *   bun packages/board-workflow/scripts/bench.ts pairs CONFIG.json OUT_DIR [--jobs 3] [--budget 900] [--kicad-cli P] [--krt DIR]
 *       the same pair actions on several boards, one table; CONFIG {"boards": [{"name", "src", "pcb"?}], "actions": [...]};
 *       each src is an onboarded board folder
 *   bun packages/board-workflow/scripts/bench.ts review BOARDS_DIR WORK_DIR [--kicad-cli P] [--out FILE]
 *       the review's escape replay over the replay boards (the toolkit's review/bench/boards); set FABDESK_FETCH_CACHE to
 *       a JLC/EasyEDA cache for the card checks offline
 *
 * They measure the workflow (edit stage, last-mile pair tools, the reviewer) rather than serve a design, so they sit
 * here as library functions (`bench` export) plus this script: an agent never needs them to finish a board.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runDrc, runKicadCli } from "../../kicad/src/index";
import { bench, drcInputFromFile, lastmile as L, layout, locateProject, readRequirements, runAcceptance, type CliResult, type Requirements } from "../src/index";

const [cmd, ...rest] = process.argv.slice(2);
const { values: o, positionals: pos } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    stem: { type: "string" },
    fixed: { type: "string" },
    root: { type: "string" },
    md: { type: "string" },
    jobs: { type: "string", default: "3" },
    budget: { type: "string", default: "900" },
    "kicad-cli": { type: "string", default: process.env["KICAD_CLI"] ?? "kicad-cli" },
    krt: { type: "string" },
    out: { type: "string" },
    heldout: { type: "boolean", default: false },
  },
});
const cli = { path: o["kicad-cli"]!, version: "" } as never;

/** The last mile's scorer and step engine on this machine's kicad-cli (and KRT when --krt is given; no host router). */
function benchDeps(req: Requirements, name: string): L.BenchDeps {
  const drc: L.DrcFn = async ({ board, parity, outFile }) => {
    const x = await runDrc(cli, { board, outFile, severity: "project", schematicParity: parity, refillZones: true });
    return { violations: x.violations, unconnected: x.unconnected, parity: x.schematicParity.length };
  };
  const host: layout.LayoutHost = {
    tools: { krt: o.krt ?? null, tracemaker: null, kicadCli: o["kicad-cli"]! },
    spawn: layout.nodeRun,
    courtyardDrc: async (board, report) => (await runDrc(cli, { board, outFile: report, severity: "all", schematicParity: false, refillZones: false })).violations.map((v) => ({ rule: v.rule, items: v.items.map((i) => ({ description: i.description })) })),
    scoreDrc: async (board, outFile, parity) => {
      const x = await drc({ board, outFile, parity });
      return { violations: x.violations.map((v) => ({ rule: v.rule, severity: v.severity, description: v.description, items: (v.items ?? []).map((i) => ({ description: i.description })) })), unconnected: x.unconnected.length, parity: x.parity };
    },
    memAvailableGiB: async () => 16,
    diskFreeGiB: async () => 100,
    log: (l) => console.log(`  ${name}`, l),
  };
  const scorer = L.createScorer(req, drc);
  const engine = L.createStepEngine({ req, drc, scorer, layout: host, fallbackRouter: "none", fill: async () => { throw new Error("no host router in the bench"); } });
  return { scorer, engine };
}

/** The edit chain's source files (the toolkit hashed edit.py, edit_move.py, edit_ops.py, bench.py, lastmile.py). */
const TOOL_VERSION_FILES = ["edit/pipeline.ts", "edit/apply.ts", "edit/move.ts", "edit/ops.ts", "lastmile/bench.ts", "lastmile/engine.ts", "lastmile/repair.ts"];
async function toolVersion(): Promise<string> {
  const h = createHash("sha256");
  for (const f of TOOL_VERSION_FILES) h.update(await readFile(join(dirname(import.meta.dir), "src", f)));
  return h.digest("hex").slice(0, 10);
}

async function main(): Promise<void> {
  switch (cmd) {
    case "edit-tasks": {
      const [name, dir, out] = pos;
      if (!name || !dir || !out) throw new Error("edit-tasks NAME PROJECT_DIR OUT_DIR");
      const files = await locateProject(resolve(dir), o.stem ? `${o.stem}.kicad_pcb` : undefined);
      const t = await bench.writeEditTasks({ name, src: files.dir, stem: files.stem, requirements: join(files.dir, ".fabdesk", "board", "requirements"), fixed: o.fixed ?? null, ...(o.root ? { root: o.root } : {}), out });
      for (const [k, v] of Object.entries(t)) console.log(`${k.padEnd(7)} ${String(v["reason"])}`);
      return;
    }
    case "edit-run": {
      const [plan, out] = pos;
      if (!plan || !out) throw new Error("edit-run PLAN.json OUT_DIR [--heldout] [--root DIR]");
      const r = await bench.runEditBench({
        planPath: plan,
        out,
        heldout: !!o.heldout,
        ...(o.root ? { root: o.root } : {}),
        toolVersion: await toolVersion(),
        accept: (dir, pcb) =>
          runAcceptance(dir, {
            pcb,
            parity: true,
            drc: async ({ board, parity, outFile }) => {
              await runDrc(cli, { board, outFile, severity: "project", schematicParity: parity, refillZones: true });
              return drcInputFromFile(outFile); // owner-excluded items dropped, as runLiveDrc does
            },
          }),
        repair: async (i) => {
          const req = await readRequirements(i.candidateDir);
          if (!req) throw new Error(`${i.candidateDir}: no requirements in the candidate`);
          return L.repairCandidate(benchDeps(req, "repair"), i);
        },
        log: (l) => console.log(`  ${l}`),
      });
      console.log(JSON.stringify({ id: r["id"], verdict: r["verdict"], total_s: r["total_s"], phases: r["phases"], churn: r["churn"], agent_coordinates: r["agent_coordinates"] }, null, 1));
      return;
    }
    case "edit-table": {
      if (!pos.length) throw new Error("edit-table RESULTS_DIR... [--md FILE]");
      const t = bench.editTable(await bench.readEditResults(pos));
      if (o.md) {
        await writeFile(o.md, t.md + "\n");
        await writeFile(o.md.replace(/\.[^./]+$/, "") + ".json", JSON.stringify(t.json, null, 1) + "\n");
      }
      console.log(t.md);
      return;
    }
    case "pairs": {
      const [config, out] = pos;
      if (!config || !out) throw new Error("pairs CONFIG.json OUT_DIR");
      const cfg = JSON.parse(await readFile(config, "utf8")) as bench.PairbenchConfig;
      const r = await bench.runPairbench(cfg, out, async (b, d) => {
        const files = await locateProject(resolve(b.src), b.pcb);
        const req = await readRequirements(files.dir);
        if (!req) throw new Error(`${b.src}: not onboarded (no requirements)`);
        const { scorer, engine } = benchDeps(req, b.name);
        const pcb = files.pcb.slice(files.dir.length + 1);
        return bench.pairbenchBoard({ name: b.name, src: files.dir, pcb, out: d, actions: cfg.actions, pairs: L.classesAndPairs(req), stack: req.acceptance.stack_policy?.copper_layers ?? [], deps: { scorer, engine }, jobs: Number(o.jobs), budget: Number(o.budget) });
      }, (l) => console.log(l));
      console.log(r.table);
      return;
    }
    case "review": {
      const [boardsDir, work] = pos;
      if (!boardsDir || !work) throw new Error("review BOARDS_DIR WORK_DIR");
      const kicad = (args: string[]): Promise<CliResult> => runKicadCli(cli, args, { tolerateExit: true });
      const kicadVersion = (await kicad(["version"])).stdout.trim();
      const r = await bench.reviewBench({ boardsDir: resolve(boardsDir), work: resolve(work), env: () => ({ kicad, kicadVersion, trustCustom: false }), progress: (n) => console.log(n) });
      if (o.out) await writeFile(o.out, JSON.stringify({ date: r.date, caught: r.caught, expected: r.expected, rows: r.rows, clean: r.clean }, null, 1) + "\n");
      console.log(`\n${r.lines.join("\n")}`);
      return;
    }
    default:
      throw new Error("usage: bench.ts edit-tasks | edit-run | edit-table | pairs | review (see the header)");
  }
}

await main();
