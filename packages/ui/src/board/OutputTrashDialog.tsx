import { useEffect, useState } from "react";
import type { OutputTrashCandidate, OutputTrashEntry, OutputTrashResult } from "@fabdesk/protocol";
import { useCoreClient } from "@fabdesk/client-core";
import { useAssistantSurface } from "../chat/useAssistantSurface";
import { useProjectExitGuard } from "../hooks/useProjectExitGuard";
import { Button, Dialog, LoadError, Spinner } from "../components/ui";
import { formatFileSize } from "./file-explorer";

export function OutputTrashReviewList({ files, selected, onSelect }: { files: OutputTrashCandidate[]; selected: string[]; onSelect: (path: string) => void }) {
  return <ul className="fd-output-trash-list">{files.map(file => <li key={file.path}>
    <label><input type="checkbox" checked={file.eligible && selected.includes(file.path)} disabled={!file.eligible} onChange={() => onSelect(file.path)} /><span><strong>{file.path}</strong><small>{file.reason}{file.size !== undefined ? ` · ${formatFileSize(file.size)}` : ""}</small></span></label>
  </li>)}</ul>;
}

/** One exact format or an explicitly selected set; supporting assets are never included implicitly. */
export function OutputTrashDialog({ projectId, paths, onClose, onChanged }: { projectId: string; paths: string[] | null; onClose: () => void; onChanged: (paths: string[]) => void }) {
  const client = useCoreClient(), recovery = paths === null;
  const [review, setReview] = useState<OutputTrashCandidate[]>([]), [entries, setEntries] = useState<OutputTrashEntry[]>([]);
  const [selected, setSelected] = useState<string[]>([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [resultAction, setResultAction] = useState<"moved to Trash" | "restored">("moved to Trash");
  const [error, setError] = useState<string | null>(null), [results, setResults] = useState<OutputTrashResult[] | null>(null), [attempt, setAttempt] = useState(0);
  useProjectExitGuard(projectId, busy ? "Wait for the output Trash operation to finish." : null);
  useAssistantSurface({ projectId, label: recovery ? "Output Trash / Restore" : "Output Trash / Confirmation", priority: 45, details: JSON.stringify({ view: recovery ? "Restore saved outputs" : "Move selected output files to recoverable Trash", paths, selected, results, error }) });
  useEffect(() => {
    let current = true; setLoading(true); setError(null); setResults(null);
    const read = async () => {
      try {
        if (paths === null) { const data = await client.listOutputTrash(projectId); if (current) { setEntries(data.files); setSelected([]); } }
        else { const data = await client.reviewOutputTrash(projectId, paths); if (current) { setReview(data.files); setSelected(data.files.filter(file => file.eligible).map(file => file.path)); } }
      } catch (error) { if (current) setError(error instanceof Error ? error.message : "Could not inspect saved outputs."); }
      finally { if (current) setLoading(false); }
    };
    void read(); return () => { current = false; };
  }, [client, projectId, paths, attempt]);
  const toggle = (value: string) => setSelected(previous => previous.includes(value) ? previous.filter(item => item !== value) : [...previous, value]);
  const apply = async (restoreIds?: string[]) => {
    if (busy) return;
    const files = review.filter(file => file.eligible && file.token && selected.includes(file.path)).map(file => ({ path: file.path, token: file.token! }));
    const ids = restoreIds ?? (recovery ? selected : null);
    if (ids ? !ids.length : !files.length) return;
    setBusy(true); setError(null); setResultAction(ids ? "restored" : "moved to Trash");
    try {
      const result = ids ? await client.restoreOutputTrash(projectId, ids) : await client.moveOutputsToTrash(projectId, files);
      setResults(result.results); setSelected([]); onChanged(result.results.filter(row => row.ok).map(row => row.path));
      if (ids) setEntries(previous => previous.filter(entry => !result.results.some(row => row.ok && row.id === entry.id)));
    } catch (failure) {
      setError(`The result could not be confirmed. ${failure instanceof Error ? failure.message : "Check your connection."} Refresh this view to check saved files before retrying.`);
      onChanged([]);
    } finally { setBusy(false); }
  };
  const movedIds = !recovery && results ? results.filter(row => row.ok && row.reason === "Moved to Output Trash." && row.id).map(row => row.id!) : [];
  return <Dialog open title={recovery ? "Output Trash" : "Move outputs to Trash"} onClose={onClose} closeDisabled={busy} className="fd-output-trash-dialog" fallbackFocus={() => document.querySelector<HTMLButtonElement>('[data-testid="output-trash-open"]')}>
    <p>{recovery ? "Restore files to their original paths. Existing files are never overwritten." : "Only checked files will be moved. Unselected formats, models, sources and supporting files stay in place. You can restore moved files from Output Trash."}</p>
    {loading && <p role="status"><Spinner />Checking saved files…</p>}
    {error && <><p role="alert">{error}</p><LoadError title="Output Trash needs attention" onRetry={() => setAttempt(value => value + 1)} /></>}
    {!loading && !error && !results && (recovery ? entries.length ? <ul className="fd-output-trash-list">{entries.map(entry => <li key={entry.id}><label><input type="checkbox" checked={selected.includes(entry.id)} onChange={() => toggle(entry.id)} /><span><strong>{entry.path}</strong><small>{formatFileSize(entry.size)} · Moved {new Date(entry.trashedAt).toLocaleString()}</small></span></label></li>)}</ul> : <p>Output Trash is empty.</p> : <><OutputTrashReviewList files={review} selected={selected} onSelect={toggle} />{review.some(file => !file.eligible) && <p className="text-muted">Protected files will stay in the Library. They can still be selected for preview or download.</p>}</>)}
    {results && <div role="status"><p>{results.filter(row => row.ok).length} of {results.length} {results.length === 1 ? "file" : "files"} {resultAction}.</p><ul className="fd-output-trash-list">{results.map((row, index) => <li key={`${row.path}:${index}`}><strong>{row.path}</strong><small>{row.ok ? row.reason : `Not changed: ${row.reason}`}</small></li>)}</ul></div>}
    <footer className="fd-output-trash-footer"><Button disabled={busy} onClick={onClose}>{results ? "Done" : "Cancel"}</Button>{results ? <>{movedIds.length > 0 && <Button disabled={busy} onClick={() => void apply(movedIds)}>{busy ? "Restoring…" : `Restore ${movedIds.length} moved ${movedIds.length === 1 ? "file" : "files"}`}</Button>}<Button disabled={busy} variant="ghost" onClick={() => setAttempt(value => value + 1)}>Refresh</Button></> : <Button variant={recovery ? "primary" : "danger"} disabled={loading || busy || !!error || !selected.length} onClick={() => void apply()}>{busy ? recovery ? "Restoring…" : "Moving…" : recovery ? `Restore ${selected.length} ${selected.length === 1 ? "file" : "files"}` : `Move ${selected.length} ${selected.length === 1 ? "file" : "files"} to Trash`}</Button>}</footer>
    <p className="text-xs text-muted">Restoring a saved output does not mark its source or engineering checks as current.</p>
  </Dialog>;
}
