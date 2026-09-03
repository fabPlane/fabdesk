// ported from fabplane packages/pcb/src/kicad-cli.ts; replace with @pcb/pcb/kicad-cli once it lands on fabplane main
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type KicadCli = { path: string; version: string };

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
  /** Resolve with the exit code instead of throwing on a non-zero exit. */
  tolerateExit?: boolean;
}

function knownLocations(): string[] {
  switch (process.platform) {
    case "darwin":
      return ["/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli", join(homedir(), "Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli")];
    case "win32": {
      // Per-machine installs, then the per-user installs winget and the "current user" installer write.
      const local = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
      return ["10.0", "9.0"].flatMap((v) => [
        `C:\\Program Files\\KiCad\\${v}\\bin\\kicad-cli.exe`,
        join(local, "Programs", "KiCad", v, "bin", "kicad-cli.exe"),
      ]);
    }
    default:
      return [
        "/usr/bin/kicad-cli",
        "/usr/local/bin/kicad-cli",
        "/usr/lib/kicad/bin/kicad-cli",
        "/usr/lib/kicad-nightly/bin/kicad-cli",
        "/opt/kicad/bin/kicad-cli",
        "/snap/bin/kicad.kicad-cli",
        join(homedir(), ".local/bin/kicad-cli"),
      ];
  }
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Locates a usable `kicad-cli`. Order: explicit argument, `$KICAD_CLI`, `PATH`, `extraLocations`,
 * then the usual install paths for the platform. Each candidate is validated by running `version`.
 */
export async function findKicadCli(explicit?: string, opts: { extraLocations?: string[] } = {}): Promise<KicadCli | null> {
  const candidates = [
    explicit,
    process.env.KICAD_CLI,
    Bun.which("kicad-cli"),
    ...(process.platform === "win32" ? [Bun.which("kicad-cli.exe")] : []),
    ...(opts.extraLocations ?? []),
    ...knownLocations(),
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  const seen = new Set<string>();
  for (const path of candidates) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (!isFile(path)) continue;
    try {
      const result = await runKicadCli({ path, version: "" }, ["version"], { tolerateExit: true });
      const version = result.stdout.trim().split("\n")[0]?.trim() ?? "";
      if (result.exitCode === 0 && version) return { path, version };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

const NOISE = [
  // macOS builds print a harmless NSCocoa error for every overwritten output file.
  "Error retrieving source file attributes",
  // Homebrew fontconfig on macOS complains about its own config.
  "Fontconfig warning:",
];

/** Runs kicad-cli with `args`, filtering platform noise from stderr. Throws on non-zero exit unless `tolerateExit`. */
export async function runKicadCli(cli: KicadCli, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  opts.signal?.throwIfAborted();
  const proc = Bun.spawn([cli.path, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  const onAbort = () => proc.kill();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, rawStderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const stderr = rawStderr
      .split("\n")
      .filter((line) => !NOISE.some((n) => line.includes(n)))
      .join("\n");
    if (opts.signal?.aborted) throw new Error(`kicad-cli ${args.slice(0, 3).join(" ")} aborted`);
    if (exitCode !== 0 && !opts.tolerateExit) {
      throw new Error(`kicad-cli ${args.slice(0, 3).join(" ")} failed (${exitCode}): ${lastLines(stderr || stdout)}`);
    }
    return { stdout, stderr, exitCode };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

export function lastLines(text: string, count = 5): string {
  return text.trim().split("\n").slice(-count).join(" | ");
}

/** Counts copper layers declared in the board file header. */
export function countCopperLayers(boardText: string): number {
  const start = boardText.indexOf("(layers");
  if (start === -1) return 0;
  // The layer block ends at the first line that closes back to the board level.
  const block = boardText.slice(start, start + 6000);
  const matches = block.match(/\(\d+\s+"(?:F|B|In\d+)\.Cu"/g);
  return matches ? matches.length : 0;
}
