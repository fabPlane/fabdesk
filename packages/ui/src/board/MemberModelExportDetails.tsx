import { useAssemblyBoardModel, useBoardSources } from "@fabdesk/client-core";
import type { BoardSourceSelection } from "@fabdesk/protocol";
import { DisclosureSummary } from "../components/DisclosureSummary";

/** Only display exporter notes for the exact declared member and verified model bytes. */
export function MemberModelExportDetails({ projectId, sourceId, path }: { projectId: string; sourceId: string; path: string }) {
  const sources = useBoardSources(projectId), data = sources.data;
  const row = data?.sources.find(row => row.source.id === sourceId);
  if (sources.isFetching || sources.isError || data?.projectId !== projectId || data.mode !== "assembly" || !data.manifestSha256 || row?.status !== "available" || row.source.location !== "project") return null;
  const expected = `${row.source.directory === "." ? "" : `${row.source.directory}/`}renders/board.glb`;
  if (path !== expected) return null;
  return <VerifiedMemberNotes projectId={projectId} board={{ sourceId, manifestSha256: data.manifestSha256 }} path={path} />;
}

function VerifiedMemberNotes({ projectId, board, path }: { projectId: string; board: BoardSourceSelection; path: string }) {
  const model = useAssemblyBoardModel(projectId, board);
  if (model.isFetching || model.isError || model.data?.path !== path || !["source-unchanged", "source-changed"].includes(model.data.state) || !model.data.warnings.length) return null;
  return <details className="fd-model-export-details">
    <DisclosureSummary icon="warning" label="Model export details" variant="compact" warning badge={`${model.data.warnings.length} warnings`} />
    <p>The native exporter reported these notes for this saved model. Component-model coverage and physical fit are not verified.</p>
    <ul>{model.data.warnings.map((message, index) => <li key={index}>{message}</li>)}</ul>
  </details>;
}
