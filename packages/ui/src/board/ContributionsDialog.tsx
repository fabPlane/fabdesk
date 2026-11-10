import type { ProjectDetail } from "@fabdesk/protocol";
import { DownloadedCopyDialog } from "./DownloadedCopyDialog";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { errorPayload, useCoreClient } from "@fabdesk/client-core";
import { Button, Dialog, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";
import "./project-sharing.css";

/** Separate from preview sharing: every editable-board publication is explicit. */
export function ContributionsDialog({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const client = useCoreClient(),
    cache = useQueryClient();
  const state = useQuery({
    queryKey: ["contributions", client.baseUrl, projectId],
    queryFn: () => client.localContributions(projectId),
    refetchInterval: 5000,
  });
  const [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState("");
  const [downloaded, setDownloaded] = useState<ProjectDetail | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const publish = async (sourceId: string) => {
    setBusy(sourceId);
    setError(null);
    setNotice("");
    try {
      await client.publishContribution(projectId, sourceId);
      await cache.invalidateQueries({ queryKey: ["project", projectId] });
      setNotice("Board revision published. Other boards and project access are unchanged.");
      setConfirm(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
      await state.refetch();
    }
  };
  return (
    <>
      <Dialog
        open
        title="Editable boards"
        onClose={onClose}
        closeDisabled={!!busy}
        className="fd-share-dialog"
      >
        <p className="fd-share-muted">
          Share a KiCad PCB and its saved schematic with Contributors. Edit local copies, then
          publish one board at a time.
        </p>
        <p className="fd-share-muted">
          Chats, scripts and other project files stay private. Custom libraries and external 3D
          assets aren’t included.
        </p>
        {(error || state.error) && (
          <p role="alert" className="fd-share-error">
            {errorPayload(error ?? state.error).message}{" "}
            <Button size="sm" onClick={() => void state.refetch()}>
              Retry
            </Button>
          </p>
        )}
        {state.isPending && (
          <p role="status">
            <Spinner />
            Checking board revisions…
          </p>
        )}
        {state.data?.role === "viewer" && (
          <p role="status">
            You have Viewer access. Your local files are kept, but downloading newer editable copies
            and publishing require Contributor access.
          </p>
        )}
        <ul className="fd-contribution-list">
          {!state.isError &&
            state.data?.boards.map((b) => (
              <li key={b.sourceId}>
                <div>
                  <strong>{b.name}</strong>
                  <small>
                    {!b.revision
                      ? "Editable files not shared"
                      : b.publishedBy
                        ? `Published by ${b.publishedBy} · ${new Date(b.publishedAt!).toLocaleString()}`
                        : "Published revision"}
                  </small>
                  {b.revision && b.revision !== b.baseRevision && (
                    <small>A newer copy is available. Your local edits are kept.</small>
                  )}
                </div>
                {b.canPublish ? (
                  <Button size="sm" disabled={!!busy} onClick={() => setConfirm(b.sourceId)}>
                    {busy === b.sourceId
                      ? "Publishing…"
                      : b.revision
                        ? "Publish update"
                        : "Share editable board"}
                  </Button>
                ) : !b.available ? (
                  <small>Board source unavailable</small>
                ) : b.revision && state.data?.role !== "viewer" ? (
                  <Button
                    size="sm"
                    disabled={!!busy}
                    onClick={async () => {
                      setBusy(b.sourceId);
                      setError(null);
                      try {
                        const p = await client.importTeamBoard(state.data!.projectId, b.id);
                        await cache.invalidateQueries();
                        const ui = useUiStore.getState();
                        if (ui.activeProjectId && ui.activeProjectId !== p.id) setDownloaded(p);
                        else if (ui.setActiveProject(p.id)) {
                          ui.setBoardOpen(true);
                          onClose();
                        }
                      } catch (e) {
                        setError(e);
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    Get latest copy
                  </Button>
                ) : null}
              </li>
            ))}
        </ul>
        {confirm && (
          <section className="fd-contribution-confirm">
            <strong>
              {state.data?.boards.find((b) => b.sourceId === confirm)?.revision
                ? "Publish this board update?"
                : "Share this board’s editable files?"}
            </strong>
            <p>
              The PCB and saved schematic will be available to this project’s Contributors. Saved
              previews, 3D models and checks from this copy will update for project visitors;
              missing outputs won’t be carried over. Downloaded copies cannot be recalled.
            </p>
            <Button variant="primary" disabled={!!busy} onClick={() => void publish(confirm)}>
              Confirm publication
            </Button>
            <Button variant="ghost" disabled={!!busy} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </section>
        )}
        {notice && (
          <p role="status" className="fd-share-notice">
            {notice}
          </p>
        )}
        <p className="fd-share-muted">
          A newer revision blocks stale updates. “Get latest copy” opens a separate project and
          keeps this copy’s edits.
        </p>
        <footer className="fd-share-footer">
          <Button variant="ghost" disabled={!!busy} onClick={onClose}>
            Done
          </Button>
        </footer>
      </Dialog>
      {downloaded && (
        <DownloadedCopyDialog
          copy={downloaded}
          onClose={() => {
            setDownloaded(null);
            setNotice("The downloaded copy is saved in Projects. Your current copy is kept.");
          }}
          onOpened={onClose}
        />
      )}
    </>
  );
}
