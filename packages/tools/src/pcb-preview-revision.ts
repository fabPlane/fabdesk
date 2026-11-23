import { snapshotProjectDependencies, type ProjectDependencies } from "./project-dependencies";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PCB_PREVIEW_REVISION_PATH, PcbPreviewRevision } from "@fabdesk/protocol";
import { jailPath, writeJson } from "./fs";

export async function pcbPreviewFileHash(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** A separate receipt per artifact avoids unrelated exporters overwriting one shared manifest. */
export async function recordPcbPreviewRevision(dir: string, sourceSha256: string, artifactSha256: string, dependencies?: ProjectDependencies): Promise<void> {
  const receiptPath = await jailPath(dir, PCB_PREVIEW_REVISION_PATH);
  const receipt = PcbPreviewRevision.parse({
    contract: "fabplane.pcb-preview-revision.v1",
    source: "board.kicad_pcb",
    artifact: "renders/pcb.svg",
    sourceSha256,
    artifactSha256,
    generatedAt: new Date().toISOString(),
    dependencySnapshot: dependencies ?? await snapshotProjectDependencies(dir),
  });
  await writeJson(receiptPath, receipt);
}
