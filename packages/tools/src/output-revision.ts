import { createHash } from "node:crypto";
import { OutputRevision } from "@fabdesk/protocol";
import type { ToolContext } from "./registry";

export function outputRevision(ctx: ToolContext, artifact: string, bytes: Uint8Array, basis: "pcb" | "saved-files", inputs: OutputRevision["inputs"]): string {
  return JSON.stringify(OutputRevision.parse({ contract: "fabplane.output-revision.v1", projectId: ctx.requireProject().id,
    ...(ctx.board ? { board: ctx.board } : {}), artifact, artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    basis, inputs, generatedAt: new Date().toISOString(), dependencies: "unverified" }), null, 2) + "\n";
}
