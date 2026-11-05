import { useEffect, useRef, useState } from "react";
import { captureKeptOutput, keptOutputKey, keptOutputMatches, useCoreClient, useKeptOutputIdentity, type KeptOutputKind } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { Button } from "../components/ui";

/** Keeps a deliberate saved output, with its stale warning and electrical checks unchanged. */
export function KeepSavedOutput({ projectId, kind, eligible }: { projectId: string; kind: KeptOutputKind; eligible: boolean }) {
  const client = useCoreClient(), key = keptOutputKey(client.baseUrl, projectId, kind);
  const choice = useUiStore(state => state.keptOutputChoices[key]);
  const identity = useKeptOutputIdentity(projectId, kind, eligible && !!choice);
  const [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const kept = !!choice && !!identity.data && !identity.isError && !identity.isFetching && keptOutputMatches(choice, identity.data);
  const checking = !!choice && (identity.isPending || identity.isFetching);
  const focus = () => requestAnimationFrame(() => root.current?.focus());
  const keep = async () => {
    if (!eligible || saving || useUiStore.getState().activeProjectId !== projectId) return;
    setSaving(true); setError(null);
    try {
      const captured = await captureKeptOutput(client, projectId, kind);
      if (!mounted.current || useUiStore.getState().activeProjectId !== projectId) return;
      useUiStore.getState().setKeptOutputChoice(key, captured);
      focus();
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : "Could not keep this version. Review the saved files again."); }
    finally { if (mounted.current) setSaving(false); }
  };
  if (!eligible) return null;
  return <div ref={root} tabIndex={-1} className="fd-kept-output" role="group" aria-label={`Saved version choice for ${kind === "pcb-preview" ? "PCB preview" : "board model"}`}>
    {kept ? <><span>Kept saved version</span><Button size="sm" variant="ghost" onClick={() => { useUiStore.getState().setKeptOutputChoice(key, null); setError(null); focus(); }}>Review choice</Button></> : <Button size="sm" variant="ghost" disabled={saving || checking} title="Keep the saved file without regenerating it. Its stale-source warning stays visible." onClick={() => void keep()}>{saving ? "Checking saved version…" : checking ? "Checking kept version…" : "Keep saved version"}</Button>}
    {kept && <small>This device · review again if the PCB or output changes</small>}
    {identity.isError && choice && <small>Kept version could not be rechecked. Choose again after reviewing the current files.</small>}
    {error && <small role="alert">{error}</small>}
  </div>;
}
