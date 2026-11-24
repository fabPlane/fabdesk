import type { BoardSourceSelection } from "@fabdesk/protocol";
import { z } from "zod/v4";
import type { CoreClient } from "./CoreClient";
import { sha256Blob } from "./pcb-preview-revision";
import type { ToolRunState } from "./tools";

const reportSchema = z.object({
  json: z.object({
    relativePath: z.string(), sourceSha256: z.hash("sha256"), svgSha256: z.hash("sha256"),
    widthMm: z.number().positive(), heightMm: z.number().positive(),
  }),
});

/** Read the exact mask that the selected board revision produced, including from a remote core. */
export async function prepareComMarkerArtwork(options: {
  client: Pick<CoreClient, "readFileBlob" | "inspectBoardSources">;
  projectId: string; prefix: string; board?: BoardSourceSelection;
  run: (tool: string, args: Record<string, unknown>) => Promise<ToolRunState>;
}) {
  const { client, projectId, prefix, board, run } = options;
  const read = (path: string) => client.readFileBlob(projectId, prefix + path);
  const expectedSourceSha256 = await sha256Blob(await read("board.kicad_pcb"));
  const result = await run("export_commarker_copper", { projectId, expectedSourceSha256, ...(board ? { board } : {}) });
  if (result.status !== "done") throw new Error(result.error ?? "Copper export failed. Try again.");
  const parsed = reportSchema.safeParse(result.result);
  if (!parsed.success) throw new Error("The copper exporter returned an incomplete file receipt.");
  const { relativePath, sourceSha256, svgSha256, widthMm, heightMm } = parsed.data.json;
  if (sourceSha256 !== expectedSourceSha256 || relativePath !== `exports/commarker/copper-${sourceSha256}.svg`) {
    throw new Error("This artwork belongs to a different board revision. Prepare it again.");
  }
  const svg = await read(relativePath);
  if (await sha256Blob(svg) !== svgSha256) throw new Error("The saved copper artwork changed. Prepare it again.");
  const current = await client.inspectBoardSources(projectId);
  if (current.projectId !== projectId) throw new Error("The selected project changed. Select the board again.");
  if (board) {
    const row = current.sources.find(candidate => candidate.source.id === board.sourceId);
    if (current.mode !== "assembly" || current.manifestSha256 !== board.manifestSha256 || row?.status !== "available" || row.source.location !== "project" || row.pcbSha256 !== sourceSha256 || (row.source.directory === "." ? "" : row.source.directory + "/") !== prefix) {
      throw new Error("The selected board source changed. Select it again.");
    }
  } else if (current.mode !== "single") {
    throw new Error("The board source changed. Select it again.");
  }
  if (await sha256Blob(await read("board.kicad_pcb")) !== sourceSha256) throw new Error("The board changed during export. Prepare it again.");
  return { svg, filename: `copper-${sourceSha256}.svg`, widthMm, heightMm };
}
