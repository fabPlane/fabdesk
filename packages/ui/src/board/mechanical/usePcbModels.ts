import { useEffect, useMemo, useRef, useState } from "react";
import {
  currentPcbDisplays,
  refreshPcbDisplays,
  useCoreClient,
  type PcbDisplay,
} from "@fabdesk/client-core";
import type { SceneModel } from "./MechanicalScene";

export function usePcbModels(
  projectId: string,
  boards: Array<{ path: string; pcbRevision: string }>,
  active = true,
) {
  const client = useCoreClient();
  const [attempt, retry] = useState(0);
  const [snapshot, setSnapshot] = useState({ projectId, models: {} as Record<string, PcbDisplay> });
  const latest = useRef(snapshot);
  const consumedAttempt = useRef(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const signature = JSON.stringify(boards);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const refresh = consumedAttempt.current !== attempt;
    consumedAttempt.current = attempt;
    setError("");
    setLoading(!!boards.length);
    void (async () => {
      await refreshPcbDisplays(client, projectId, boards, {
        previous: latest.current,
        refresh,
        cancelled: () => cancelled,
        publish: (models, error) => {
          latest.current = { projectId, models };
          setSnapshot(latest.current);
          setError(error);
        },
      });
      if (!cancelled) {
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, projectId, signature, attempt, active]);
  // Never show the previous revision while its replacement is loading.
  const current = useMemo(
    () => currentPcbDisplays(snapshot, projectId, boards),
    [snapshot, signature, projectId],
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
