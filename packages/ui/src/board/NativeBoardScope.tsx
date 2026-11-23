import { Button } from "../components/ui";
import { useMemo, type ReactNode } from "react";
import { CoreProvider, useCore, type WorkingDesign } from "@fabdesk/client-core";
/** Reuses every normal board workflow with one immutable source-scoped client/cache. */
export function NativeBoardScope({
  projectId,
  threadId,
  design,
  enabled,
  pending = false,
  error = null,
  onRetry,
  children,
}: {
  projectId: string | null;
  threadId: string | null;
  design: WorkingDesign | undefined;
  enabled: boolean;
  pending?: boolean;
  error?: string | null;
  onRetry?: () => void;
  children: ReactNode;
}) {
  const { client, host } = useCore();
  const scoped = useMemo(
    () =>
      enabled && projectId && design?.sourcePath
        ? client.withNativeSource({
            projectId,
            ...(threadId ? { threadId } : {}),
            sourcePath: design.sourcePath,
          })
        : null,
    [client, enabled, projectId, threadId, design?.sourcePath],
  );
  // Do not mount source-dependent queries or mutations with an unresolved identity.
  // Even previously cached data cannot authorize root operations after a failed lookup.
  if (enabled && projectId && (pending || error || !design)) return <div className="p-6 pt-20 text-sm" role={error ? "alert" : "status"}>
    <p>{error ? "Could not load the working source" : "Loading working source…"}</p>
    {error && <><p>{error}</p><Button size="sm" onClick={onRetry}>Retry source</Button></>}
  </div>;
  return scoped ? (
    <CoreProvider key={scoped.baseUrl} client={scoped} host={host}>
      {children}
    </CoreProvider>
  ) : (
    children
  );
}
