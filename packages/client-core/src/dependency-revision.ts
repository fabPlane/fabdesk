import type { ProjectDependencySnapshot } from "@fabdesk/protocol";
import type { CoreClient } from "./CoreClient";
/** Re-scan dependencies on the daemon so new library files and model substitutions also invalidate views.
 * A receipt's unresolved inputs remain unverified even when its measured inputs match. */
export async function dependenciesMatch(
  client: Pick<CoreClient, "readFileBlob">,
  projectId: string,
  snapshot?: ProjectDependencySnapshot,
  prefix = "",
): Promise<boolean> {
  if (!snapshot) return true;
  const api = client as Pick<CoreClient, "readFileBlob"> & Partial<Pick<CoreClient, "inspectOutputDependencies">>;
  if (!api.inspectOutputDependencies) return false;
  return (await api.inspectOutputDependencies(projectId, prefix ? prefix.slice(0, -1) : ".")).revision === snapshot.revision;
}
