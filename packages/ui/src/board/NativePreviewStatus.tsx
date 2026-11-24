import { Button } from "../components/ui";

/** Automatic preparation is distinct from the viewer's loaded-byte receipt. */
export function NativePreviewStatus({ source, pending, error, onRetry }: {
  source: string; pending: boolean; error: string | null; onRetry: () => void;
}) {
  if (!pending && !error) return null;
  return <div className="px-3 py-2 text-xs" role={error && !pending ? "alert" : "status"}>
    <p>{pending ? "Updating preview…" : "Automatic preview failed"} · {source}</p>
    <p>Any previous preview may be older than the saved source.</p>
    {error && <><p>{error}</p><Button size="sm" disabled={pending} onClick={onRetry}>{pending ? "Retrying…" : "Retry preview"}</Button></>}
  </div>;
}
