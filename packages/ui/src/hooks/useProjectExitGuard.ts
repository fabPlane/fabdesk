import { useEffect, useId } from "react";
import { useUiStore } from "../stores/ui";

/** Local forms that cannot be restored must be resolved before their workspace unmounts. */
export function useProjectExitGuard(projectId: string | null, message: string | null) {
  const key = useId();
  useEffect(() => {
    useUiStore.getState().setProjectExitBlock(key, projectId && message ? { projectId, message } : null);
    return () => useUiStore.getState().setProjectExitBlock(key, null);
  }, [key, projectId, message]);
}
