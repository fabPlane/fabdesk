/**
 * Inner-power audit parity: the toolkit's `tools/stack_audit.py` `inspect` + `review/power_stack.py` `audit` against
 * `stackCensus` + `auditPower` on one board.
 *
 *   bun packages/board-workflow/test/parity-power-stack.ts --pcb BOARD.kicad_pcb --acceptance acceptance.json --netlist netlist.xml [--toolkit DIR] [--out DIR] [--flow-spec SPEC.json]
 *
 * Not part of `bun run test` (needs the Python toolkit with shapely). The netlist is KiCad's XML export (a review run's
 * `netlist.xml`). Compares the census and the audit value by value: numbers must be equal (bit for bit), and the
 * difference is reported where they are not. Exit 0 only when both are equal.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { auditPower, loadNetlist, readBoard, stackCensus, type Acceptance } from "../src/index";
import { parseSexpr } from "../src/sexpr";

const { values: a } = parseArgs({
  options: {
    pcb: { type: "string" },
    acceptance: { type: "string" },
    netlist: { type: "string" },
    toolkit: { type: "string", default: "/home/shane/pcb" },
    out: { type: "string" },
    "flow-spec": { type: "string" },
  },
});
if (!a.pcb || !a.acceptance || !a.netlist) throw new Error("--pcb, --acceptance and --netlist are required");
const out = a.out ?? join(process.env["TMPDIR"] ?? "/tmp", `parity-power-stack-${process.pid}`);
await mkdir(out, { recursive: true });

const PY = `
import json, sys
from pathlib import Path
kit = sys.argv[1]
sys.path.insert(0, kit + '/tools'); sys.path.insert(0, kit + '/review')
from stack_audit import inspect
from power_stack import audit
pcb, acc, netlist, out = map(Path, sys.argv[2:6])
c = inspect(pcb, json.loads(acc.read_text()), netlist)
(out / 'py-census.json').write_text(json.dumps(c))
(out / 'py-audit.json').write_text(json.dumps(audit(c)))
`;
const py = Bun.spawnSync(["python3", "-c", PY, a.toolkit!, a.pcb, a.acceptance, a.netlist, out], {
  cwd: a.toolkit!,
  stdout: "pipe",
  stderr: "pipe",
  // the toolkit reads a `*.Cu` pad's layers from its board context (FLOW_SPEC; C6's 8 layers when unset)
  env: { ...process.env, ...(a["flow-spec"] ? { FLOW_SPEC: a["flow-spec"] } : {}) },
});
if (py.exitCode !== 0) throw new Error(`toolkit failed: ${py.stderr.toString()}`);

const text = await readFile(a.pcb, "utf8");
const root = parseSexpr(text);
const acc = JSON.parse(await readFile(a.acceptance, "utf8")) as Acceptance;
const comps = loadNetlist(await readFile(a.netlist, "utf8"));
const t0 = performance.now();
const census = stackCensus(text, root, readBoard(root), acc, comps, a.pcb);
const audit = auditPower(census);
const ms = performance.now() - t0;
await writeFile(join(out, "ts-census.json"), JSON.stringify(census));
await writeFile(join(out, "ts-audit.json"), JSON.stringify(audit));

const diffs: string[] = [];
let numbers = 0;
function cmp(x: unknown, y: unknown, path: string, unordered = false): void {
  if (typeof x === "number" && typeof y === "number") {
    numbers++;
    if (!Object.is(x, y) && !(x === 0 && y === 0)) diffs.push(`${path}: py ${x} ts ${y} (rel ${Math.abs(x - y) / Math.max(Math.abs(x), 1e-300)})`);
    return;
  }
  if (Array.isArray(x) && Array.isArray(y)) {
    if (x.length !== y.length) return void diffs.push(`${path}: length py ${x.length} ts ${y.length}`);
    const xs = unordered ? [...x].sort() : x, ys = unordered ? [...y].sort() : y;
    xs.forEach((v, i) => cmp(v, ys[i], `${path}[${i}]`));
    return;
  }
  if (x && y && typeof x === "object" && typeof y === "object") {
    const xo = x as Record<string, unknown>, yo = y as Record<string, unknown>;
    for (const k of new Set([...Object.keys(xo), ...Object.keys(yo)])) {
      if (!(k in xo) || !(k in yo)) {
        diffs.push(`${path}.${k}: only in ${k in xo ? "py" : "ts"}`);
        continue;
      }
      // a via's two layers: the toolkit writes them in stack order, Fabdesk as written (the audit sorts them itself)
      cmp(xo[k], yo[k], `${path}.${k}`, k === "layers" && path.includes(".vias"));
    }
    return;
  }
  if (x !== y) diffs.push(`${path}: py ${JSON.stringify(x)} ts ${JSON.stringify(y)}`);
}
const pyCensus = JSON.parse(await readFile(join(out, "py-census.json"), "utf8")) as Record<string, unknown>;
const pyAudit = JSON.parse(await readFile(join(out, "py-audit.json"), "utf8"));
// the toolkit's census names the board by the path it was given; pair layers are a Python set (arbitrary order)
cmp({ ...pyCensus, board: "" }, { ...JSON.parse(JSON.stringify(census)), board: "" }, "census");
cmp(pyAudit, JSON.parse(JSON.stringify(audit)), "audit");
const rows = audit.rows.map((r) => `${r.net}: ${r.current_A} A, ${r.ipc2221_C.toFixed(2)} C, ${r.drop_mV.toFixed(2)} mV, ${r.graph.model_nodes} nodes, ${r.terminals.length} terminals, missing ${r.graph.missing_terminals.length}, disconnected ${r.graph.disconnected_terminal_pairs.length}, ${r.pass ? "PASS" : "FAIL"}`);
console.log([`board ${a.pcb}`, `TypeScript ${ms.toFixed(0)} ms; ${numbers} numbers compared`, ...rows, diffs.length ? `${diffs.length} differences:\n  ${diffs.slice(0, 40).join("\n  ")}` : "census and audit equal"].join("\n"));
process.exit(diffs.length ? 1 : 0);
