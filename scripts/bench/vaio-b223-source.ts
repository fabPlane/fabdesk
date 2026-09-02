/**
 * The pinned B2.23 input of docs/RUN_VERIFY_ROUTER_B223_TO_B223_1.md (vaio_cm5_carrier). The
 * board is private: nothing from it is committed here; `fetchVaioBoard` reads it out of the
 * carrier repository at the pinned commit and verifies the hash before anything parses it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const VAIO_B223 = {
  repo: process.env["VAIO_CARRIER_REPO"] ?? "/Users/hyper/projects/tensorfleet/vaio_cm5_carrier",
  commit: "0a79b3099c4af878b11aa172f8d677399c4329ec",
  pcbPath: "kicad-b2.23-usb3-rx2-skew/vaio_cm5_carrier.kicad_pcb",
  proPath: "kicad-b2.23-usb3-rx2-skew/vaio_cm5_carrier.kicad_pro",
  pcbSha256: "959e6ad6c10284e1434398b1c3bd93a36629190a992b49883f6d3117fcb70318",
  /** Runbook section 4: the nine mirrored footprints (the repair scope). */
  repairRefs: ["U701", "U702", "U704", "U707", "Q701", "D403", "D703", "U705", "U706"],
  /** Queried by JLC but correct: a negative control, not part of the repair. */
  controlRefs: ["D402"],
  copperLayers: 6,
} as const;

async function gitShow(repo: string, commit: string, path: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repo, "show", `${commit}:${path}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git show ${commit}:${path} failed in ${repo}: ${err.trim()}`);
  return out;
}

/**
 * Reads the pinned board (+ project file) with `git show`, verifies the SHA-256 and writes both
 * into `outDir` (never inside a repository). Returns the written paths and the verified hash.
 */
export async function fetchVaioBoard(
  outDir: string,
): Promise<{ pcbPath: string; proPath: string; sha256: string; bytes: number }> {
  const commitType = Bun.spawnSync(
    ["git", "-C", VAIO_B223.repo, "cat-file", "-t", VAIO_B223.commit],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (!commitType.success || commitType.stdout.toString().trim() !== "commit") {
    throw new Error(
      `pinned commit ${VAIO_B223.commit} not found in ${VAIO_B223.repo} (set VAIO_CARRIER_REPO)`,
    );
  }
  const pcb = await gitShow(VAIO_B223.repo, VAIO_B223.commit, VAIO_B223.pcbPath);
  const sha256 = createHash("sha256").update(pcb).digest("hex");
  if (sha256 !== VAIO_B223.pcbSha256) {
    throw new Error(
      `board hash mismatch: expected ${VAIO_B223.pcbSha256}, got ${sha256} -- refusing to use it`,
    );
  }
  const pro = await gitShow(VAIO_B223.repo, VAIO_B223.commit, VAIO_B223.proPath);
  await mkdir(outDir, { recursive: true });
  const pcbPath = join(outDir, "vaio_cm5_carrier.kicad_pcb");
  const proPath = join(outDir, "vaio_cm5_carrier.kicad_pro");
  await writeFile(pcbPath, pcb);
  await writeFile(proPath, pro);
  return { pcbPath, proPath, sha256, bytes: Buffer.byteLength(pcb) };
}
