import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { currentReviewHash } from "@fabdesk/board-workflow";
/** A structurally valid release package; generation/CAM gates are tested separately. */
export async function packageFixture(dir: string, path = "exports/release-test", receipt = true, accepted: Record<string, string> = {}, pcb = "board.kicad_pcb") {
  const out = join(dir, path); await mkdir(out, { recursive: true });
  const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
  const hash = await currentReviewHash(dir);
  const boardSha256 = sha(await readFile(join(dir, pcb)));
  const gate = JSON.stringify({ reviewDesignHash: hash });
  await writeFile(join(out, "acceptance-gate.json"), gate);
  await writeFile(join(out, "evidence.txt"), "evidence");
  const manifest = JSON.stringify({ sources: { pcb: boardSha256, pcb_path: pcb }, accepted_exceptions: accepted, files: { "acceptance-gate.json": sha(gate), "evidence.txt": sha("evidence") } });
  await writeFile(join(out, "manifest.json"), manifest);
  if (receipt) {
    await mkdir(join(dir, ".fabdesk/board/release"), { recursive: true });
    await writeFile(join(dir, ".fabdesk/board/release/last-fab.json"), JSON.stringify({ designHash: hash, out, manifestSha256: sha(manifest), pcb, boardSha256 }));
  }
  return out;
}
