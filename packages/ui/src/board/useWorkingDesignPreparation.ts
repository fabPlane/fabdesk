import { useEffect, useState } from "react";
import { useWorkingDesign, useWorkingDesignRender } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";

/** Prepare content after saved inputs settle. This hook never changes panel navigation. */
export function useWorkingDesignPreparation() {
  const projectId = useUiStore((s) => s.activeProjectId),
    threadId = useUiStore((s) => s.activeThreadId);
  const design = useWorkingDesign(projectId, threadId);
  const key = JSON.stringify([
    projectId,
    threadId,
    design.data?.sourcePath,
    design.data?.sourceRevision,
  ]);
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(key), 2000);
    return () => clearTimeout(timer);
  }, [key]);
  const ready = settled === key && !!projectId && !design.isError;
  const pcb = useWorkingDesignRender(
    projectId ?? "",
    threadId,
    design.data,
    "pcb",
    ready && !!design.data?.board,
  );
  const schematic = useWorkingDesignRender(
    projectId ?? "",
    threadId,
    design.data,
    "schematic",
    ready && !!design.data?.schematic,
  );
  const model = useWorkingDesignRender(
    projectId ?? "",
    threadId,
    design.data,
    "3d",
    ready && !!design.data?.board,
  );
  return { pcb, schematic, model };
}
