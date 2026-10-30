import { AssemblyRelativePath, OutputRevision, type BoardSourceSelection } from "@fabdesk/protocol";
import { CoreHttpError, type CoreClient } from "./CoreClient";
import { sha256Blob } from "./pcb-preview-revision";

export type OutputRevisionState = { state: "untracked" | "scope-unverified" | "artifact-changed" | "missing-artifact" | "input-changed" | "missing-input" | "inputs-unchanged"; basis?: "pcb" | "saved-files" };
export type OutputRevisionTarget = { path: string; directory: string; board?: BoardSourceSelection };

/** Check the exact file and inputs from a qualified exporter receipt. Legacy files stay unverified. */
export async function inspectOutputRevision(client: Pick<CoreClient, "readFile" | "readFileBlob">, projectId: string, target: OutputRevisionTarget): Promise<OutputRevisionState> {
  const prefix = target.directory === "." ? "" : `${AssemblyRelativePath.parse(target.directory)}/`;
  if (!AssemblyRelativePath.safeParse(target.path).success || !target.path.startsWith(prefix)) return { state: "scope-unverified" };
  const logical = target.path.slice(prefix.length);
  let raw: unknown;
  try { raw = JSON.parse(await client.readFile(projectId, `${target.path}.revision.json`)); }
  catch (failure) { if (failure instanceof SyntaxError || failure instanceof CoreHttpError && failure.status === 404) return { state: "untracked" }; throw failure; }
  const parsed = OutputRevision.safeParse(raw);
  if (!parsed.success) return { state: "untracked" };
  const receipt = parsed.data, board = target.board;
  if (receipt.projectId !== projectId || receipt.artifact !== logical || (board ? receipt.board?.sourceId !== board.sourceId || receipt.board.manifestSha256 !== board.manifestSha256 : !!receipt.board)) return { state: "scope-unverified" };
  const read = async (path: string) => {
    try { return await client.readFileBlob(projectId, prefix + path); }
    catch (failure) { if (failure instanceof CoreHttpError && failure.status === 404) return null; throw failure; }
  };
  const artifact = await read(receipt.artifact);
  if (!artifact) return { state: "missing-artifact", basis: receipt.basis };
  if (await sha256Blob(artifact) !== receipt.artifactSha256) return { state: "artifact-changed", basis: receipt.basis };
  for (const input of receipt.inputs) {
    const bytes = await read(input.path);
    if (!bytes) return { state: "missing-input", basis: receipt.basis };
    if (await sha256Blob(bytes) !== input.sha256) return { state: "input-changed", basis: receipt.basis };
  }
  return { state: "inputs-unchanged", basis: receipt.basis };
}

export function outputRevisionLabel(result: OutputRevisionState | undefined): string {
  switch (result?.state) {
    case "inputs-unchanged": return result.basis === "saved-files" ? "Packaged files unchanged · PCB not compared" : "Recorded PCB input unchanged · Dependencies unverified";
    case "input-changed": return result.basis === "saved-files" ? "Packaged files changed · Review ZIP" : "PCB changed since export · Review output";
    case "missing-input": return "Recorded input missing · Saved output";
    case "artifact-changed": return "Output changed · Source unverified";
    case "missing-artifact": return "Saved output file missing";
    case "scope-unverified": return "Output ownership unverified";
    default: return "Source not checked";
  }
}
export const outputInputsNeedReview = (result: OutputRevisionState | undefined) => !!result && ["input-changed", "missing-input", "artifact-changed", "missing-artifact", "scope-unverified"].includes(result.state);
