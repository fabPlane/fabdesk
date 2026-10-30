import { useEffect, useMemo, useState } from "react";
import { loadPcbDisplay, useCoreClient, type PcbDisplay } from "@fabdesk/client-core";
import type { SceneModel } from "./MechanicalScene";

export function usePcbModels(
  projectId: string,
  boards: Array<{ path: string; pcbRevision: string }>,
  active = true,
) {
  const client = useCoreClient();
  const [attempt, retry] = useState(0);
  const [models, setModels] = useState<Record<string, PcbDisplay>>({});
  const [modelProject, setModelProject] = useState(projectId);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const signature = JSON.stringify(boards);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setError("");
    setLoading(!!boards.length);
    void (async () => {
      const next: Record<string, PcbDisplay> = {};
      const errors: string[] = [];
      for (const board of boards) {
        try {
          const model = await loadPcbDisplay(
            client,
            projectId,
            board.path,
            board.pcbRevision,
            attempt > 0,
          );
          next[board.path] = model;
        } catch (e) {
          errors.push(`${board.path}: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (cancelled) return;
        setModelProject(projectId);
        setModels({ ...next });
      }
      if (!cancelled) {
        setError(errors.join("\n"));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, projectId, signature, attempt, active]);
  // Never show the previous revision while its replacement is loading.
  const current = useMemo(
    () =>
      Object.fromEntries(
        boards.flatMap((b) => {
          const model = models[b.path];
          return modelProject === projectId && model?.pcbRevision === b.pcbRevision
            ? [[b.path, model]]
            : [];
        }),
      ) as Record<string, PcbDisplay>,
    [models, signature, modelProject, projectId],
  );
  return { models: current, loading, error, retry: () => retry((n) => n + 1) };
}

export function detailedBoardSource(source: SceneModel, model: PcbDisplay): SceneModel {
  const { board: _board, thickness: _thickness, ...rest } = source;
  return {
    ...rest,
    item: { ...source.item, path: model.modelPath, name: "PCB model" },
    data: model.data,
  };
}
