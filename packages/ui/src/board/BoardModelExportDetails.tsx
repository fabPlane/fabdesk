import { useBoardModelRevision, useProjectJson } from "@fabdesk/client-core";
import { BoardModelRevision, BOARD_MODEL_REVISION_PATH } from "@fabdesk/protocol";
import { DisclosureSummary } from "../components/DisclosureSummary";

/** Historical exporter context is shown only while its saved artifact still matches. */
export function BoardModelExportDetails({ projectId }: { projectId: string }) {
  const revision = useBoardModelRevision(projectId), raw = useProjectJson(projectId, BOARD_MODEL_REVISION_PATH);
  const parsed = BoardModelRevision.safeParse(raw.data);
  if (revision.isFetching || !["source-unchanged", "source-changed"].includes(revision.data ?? "") || !parsed.success) return null;
  const receipt = parsed.data;
  if (!receipt.modelProjectDirectory && !receipt.warnings?.length) return null;
  return <details className="fd-model-export-details">
    <DisclosureSummary icon="folderOpen" label="Model export details" variant="compact" badge={receipt.warnings?.length ? `${receipt.warnings.length} warnings` : undefined} />
    {receipt.modelProjectDirectory && <p>Imported component-model folder: <code>{receipt.modelProjectDirectory}</code>. This records the export context; component files and full model coverage remain unverified.</p>}
    {!!receipt.warnings?.length && <><p>The native exporter reported:</p><ul>{receipt.warnings.map((message, index) => <li key={index}>{message}</li>)}</ul></>}
  </details>;
}
