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
  const confirmedBoard = state.data?.boards.find((b) => b.sourceId === confirm);
  const publish = async (sourceId: string) => {
    setBusy(sourceId);
    setError(null);
    setNotice("");
    try {
      await client.publishContribution(projectId, sourceId);
      await cache.invalidateQueries({ queryKey: ["project", projectId] });
      setNotice("Board update published.");
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
        title="Board design files"
        onClose={onClose}
        closeDisabled={!!busy}
        className="fd-share-dialog fd-board-files-dialog"
      >
        <p className="fd-share-muted">
          Contributors can download these files, edit a separate copy, then publish a board update.
        </p>
        <details className="fd-board-files-details">
          <summary>What files are shared?</summary>
          <p className="fd-share-muted">
            The KiCad PCB and saved schematic only. Chats, scripts, custom libraries and external 3D
            assets aren’t included. Viewers and public-link visitors cannot download these files.
          </p>
        </details>
        {(error || state.error) && (
          <p role="alert" className="fd-share-error">
            {errorPayload(error ?? state.error).message}{" "}
            <Button
              size="sm"
              onClick={() => {
                setError(null);
                void state.refetch();
              }}
            >
              Retry
            </Button>
          </p>
        )}
        {state.isPending && (
          <p role="status">
            <Spinner />
            Checking shared files…
          </p>
        )}
        {state.data?.role === "viewer" && (
          <p role="status">
            You have Viewer access. Your local files are kept, but downloading newer editable copies
            and publishing require Contributor access.
          </p>
        )}
        {!state.isError && state.data?.boards.length === 0 && (
          <p className="fd-share-muted">
            No boards are available here. Add or import a board to this project first.
          </p>
        )}
        <ul className="fd-contribution-list">
          {!state.isError &&
            state.data?.boards.map((b) => (
              <li key={b.sourceId}>
                <div>
                  <strong>{b.name}</strong>
                  <span className="fd-board-file-status" data-shared={!!b.revision}>
                    {b.revision ? "Shared with Contributors" : "Not shared"}
                  </span>
                  {b.revision && b.publishedBy && (
                    <small>
                      Updated by {b.publishedBy} · {new Date(b.publishedAt!).toLocaleString()}
                    </small>
                  )}
                  {b.revision && b.revision !== b.baseRevision && (
                    <small className="fd-board-copy-hint">
                      {b.baseRevision
                        ? "A newer version is available. Your local edits are kept."
                        : "Get the shared copy before publishing changes."}
                    </small>
                  )}
                </div>
                {b.canPublish ? (
                  confirm !== b.sourceId && (
                    <Button size="sm" disabled={!!busy} onClick={() => setConfirm(b.sourceId)}>
                      {b.revision ? "Publish update" : "Share files"}
                    </Button>
                  )
                ) : !b.available ? (
                  <small>No local design files</small>
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
              {confirmedBoard?.revision
                ? `Publish update for ${confirmedBoard.name}?`
                : `Share design files for ${confirmedBoard?.name ?? "this board"}?`}
            </strong>
            <p>
              Contributors will receive this board’s PCB and saved schematic. Its saved previews, 3D
              model and checks will also update on the shared page.
            </p>
            <p>
              Missing saved outputs will be removed from the shared page. Downloaded files cannot be
              recalled.
            </p>
            <div className="fd-share-link-actions">
              <Button
                variant="primary"
                disabled={!!busy || !confirmedBoard?.canPublish || state.isError}
                onClick={() => void publish(confirm)}
              >
                {busy === confirm
                  ? "Publishing…"
                  : confirmedBoard?.revision
                    ? "Publish update"
                    : "Share files"}
              </Button>
              <Button variant="ghost" disabled={!!busy} onClick={() => setConfirm(null)}>
                Cancel
              </Button>
            </div>
          </section>
        )}
        {notice && (
          <p role="status" className="fd-share-notice">
            {notice}
          </p>
        )}
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
