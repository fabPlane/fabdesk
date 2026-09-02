import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { analysisLine, ensureAcStimulus, netlistBody } from "./netlist";
import type { SimAnalysis, SimResult } from "./types";

function kicadBundledCandidates(): string[] {
  switch (process.platform) {
    case "darwin":
      return [
        "/Applications/KiCad/KiCad.app/Contents/PlugIns/sim/ngspice/bin/ngspice",
        "/Applications/KiCad/KiCad.app/Contents/MacOS/ngspice",
        join(homedir(), "Applications/KiCad/KiCad.app/Contents/MacOS/ngspice"),
      ];
    case "win32":
      return ["10.0", "9.0"].map((v) => `C:\\Program Files\\KiCad\\${v}\\bin\\ngspice.exe`);
    default:
      return ["/usr/lib/kicad/bin/ngspice", "/usr/lib/kicad-nightly/bin/ngspice", "/opt/kicad/bin/ngspice"];
  }
}

const OTHER_CANDIDATES = ["/opt/homebrew/bin/ngspice", "/usr/local/bin/ngspice", "/usr/bin/ngspice", "/opt/local/bin/ngspice"];

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Locates an `ngspice` binary: explicit, `$NGSPICE`, the KiCad-bundled location (KiCad on macOS
 * and Linux ships only libngspice, so this usually misses), `PATH`, then Homebrew/system paths.
 */
export async function findNgspice(explicit?: string): Promise<string | null> {
  const candidates = [explicit, process.env.NGSPICE, ...kicadBundledCandidates(), Bun.which("ngspice"), ...OTHER_CANDIDATES].filter(
    (c): c is string => typeof c === "string" && c.length > 0,
  );
  for (const path of new Set(candidates)) {
    if (!isFile(path)) continue;
    try {
      const proc = Bun.spawn([path, "-v"], { stdout: "pipe", stderr: "pipe" });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (code === 0 && /ngspice/i.test(out)) return path;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

interface RawFile {
  plotname: string;
  complex: boolean;
  variables: string[];
  rows: number[][];
}

/** Parses an ngspice ASCII rawfile (`set filetype=ascii` + `write`). */
export function parseAsciiRaw(text: string): RawFile {
  const lines = text.split(/\r?\n/);
  let plotname = "";
  let complex = false;
  let variableCount = 0;
  const variables: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("Plotname:")) plotname = line.slice(9).trim();
    else if (line.startsWith("Flags:")) complex = /complex/i.test(line);
    else if (line.startsWith("No. Variables:")) variableCount = Number(line.slice(14).trim());
    else if (line.startsWith("Variables:")) {
      for (let k = 0; k < variableCount; k++) {
        const parts = lines[++i]!.trim().split(/\s+/);
        variables.push(parts[1] ?? `var${k}`);
      }
    } else if (line.startsWith("Values:")) {
      i++;
      break;
    }
  }
  // Each point starts with "<index>\t<value>"; the remaining values follow one per line.
  const rows: number[][] = [];
  let current: number[] = [];
  const push = (value: string) => {
    if (complex) {
      const [re, im] = value.split(",").map(Number);
      current.push(re ?? Number.NaN, im ?? Number.NaN);
    } else current.push(Number(value));
  };
  for (; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length >= 2) {
      if (current.length) rows.push(current);
      current = [];
      push(parts[1]!);
    } else push(parts[0]!);
  }
  if (current.length) rows.push(current);
  return { plotname, complex, variables, rows };
}

function controlCommand(analysis: SimAnalysis): string {
  return analysisLine(analysis).slice(1);
}

/** Runs `ngspice -b` on the netlist and converts the ASCII rawfile into a SimResult. */
export async function runNgspice(ngspicePath: string, netlist: string, analysis: SimAnalysis, signal?: AbortSignal): Promise<SimResult> {
  signal?.throwIfAborted();
  const dir = await mkdtemp(join(tmpdir(), "fabdesk-ngspice-"));
  try {
    const rawPath = join(dir, "out.raw");
    const cirPath = join(dir, "sim.cir");
    let body = netlistBody(netlist);
    if (analysis.kind === "ac") body = ensureAcStimulus(body);
    const deck = `${body}\n.control\nset filetype=ascii\n${controlCommand(analysis)}\nwrite ${rawPath}\n.endc\n.end\n`;
    await Bun.write(cirPath, deck);
    const proc = Bun.spawn([ngspicePath, "-b", cirPath], { stdout: "pipe", stderr: "pipe", cwd: dir });
    const onAbort = () => proc.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    if (signal?.aborted) throw new Error("ngspice aborted");
    const log = `${stdout}\n${stderr}`.trim();
    const rawFile = Bun.file(rawPath);
    if (!(await rawFile.exists())) throw new Error(`ngspice exited ${exitCode} without writing results:\n${log.split("\n").slice(-12).join("\n")}`);
    const raw = parseAsciiRaw(await rawFile.text());
    const names = raw.variables.map((v) => v.toLowerCase());
    let columns: string[];
    let rows: number[][];
    if (raw.complex) {
      // First variable is the frequency sweep; real part only.
      columns = names.flatMap((name, k) => (k === 0 ? [name] : [`${name}.mag`, `${name}.phase_deg`]));
      rows = raw.rows.map((r) =>
        names.flatMap((_, k) => {
          const re = r[2 * k] ?? Number.NaN;
          const im = r[2 * k + 1] ?? Number.NaN;
          return k === 0 ? [re] : [Math.hypot(re, im), (Math.atan2(im, re) * 180) / Math.PI];
        }),
      );
    } else {
      columns = names;
      rows = raw.rows;
    }
    return { engine: "ngspice", analysis: analysis.kind, columns, rows, log };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
