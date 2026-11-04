import { useBoardModelRevision, useProjectJson } from "@fabdesk/client-core";
import { BoardModelRevision, BOARD_MODEL_REVISION_PATH } from "@fabdesk/protocol";
import { ModelExportNotes } from "./ModelExportNotes";

/** Historical exporter context is shown only while its saved artifact still matches. */
export function BoardModelExportDetails({ projectId, onAsk }: { projectId: string; onAsk?: (() => void) | undefined }) {
  const revision = useBoardModelRevision(projectId), raw = useProjectJson(projectId, BOARD_MODEL_REVISION_PATH);
  const parsed = BoardModelRevision.safeParse(raw.data);
  if (revision.isFetching || !["source-unchanged", "source-changed"].includes(revision.data ?? "") || !parsed.success) return null;
  const receipt = parsed.data;
  if (!receipt.modelProjectDirectory && !receipt.warnings?.length) return null;
  return <ModelExportNotes projectId={projectId} onAsk={onAsk} warnings={receipt.warnings ?? []} modelProjectDirectory={receipt.modelProjectDirectory} />;
}
