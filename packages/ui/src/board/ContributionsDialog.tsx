import type { ProjectDetail } from "@fabdesk/protocol";
import { DownloadedCopyDialog } from "./DownloadedCopyDialog";
import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cloudAccountId, useAuthStore, errorPayload, useCoreClient } from "@fabdesk/client-core";
import { Button, Dialog, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";
import "./project-sharing.css";

/** Separate from preview sharing: every editable-board publication is explicit. */
export function ContributionsDialog(props: { projectId: string; onClose: () => void }) {
  const account = useAuthStore(s => cloudAccountId(s.state));
  return <ContributionsForAccount key={account ?? "signed-out"} {...props} account={account} />;
}

function ContributionsForAccount({
  account,
  projectId,
  onClose,
}: {
  account: string | null;
  projectId: string;
  onClose: () => void;
}) {
  const client = useCoreClient(),
    cache = useQueryClient();
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isCurrent = () => mounted.current && cloudAccountId(useAuthStore.getState().state) === account;
  const state = useQuery({
    queryKey: ["contributions", client.baseUrl, projectId, account],
    queryFn: () => client.localContributions(projectId),
    refetchInterval: 5000,
  });
  const [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState("");
  const [downloaded, setDownloaded] = useState<ProjectDetail | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const confirmationTitleId = useId();
  const confirmationRef = useRef<HTMLElement>(null);
  const boardActions = useRef(new Map<string, HTMLButtonElement>());
  const focusBoard = useRef<string | null>(null);
  const rememberAction = (sourceId: string) => (button: HTMLButtonElement | null) => {
    if (button) boardActions.current.set(sourceId, button);
    else boardActions.current.delete(sourceId);
  };
  useEffect(() => {
    if (confirm) {
      if (focusBoard.current !== confirm) confirmationRef.current?.focus();
      focusBoard.current = confirm;
    } else if (focusBoard.current) {
      const action = boardActions.current.get(focusBoard.current);
      if (action && !action.disabled) {
        action.focus();
        focusBoard.current = null;
      }
    }
  }, [confirm, busy, state.data]);
  const confirmedBoard = state.data?.boards.find((b) => b.sourceId === confirm);
  useEffect(() => {
    if (confirm && (!confirmedBoard?.canPublish || state.isError)) setConfirm(null);
  }, [confirm, confirmedBoard?.canPublish, state.isError]);
  const publish = async (sourceId: string) => {
    const replacing = !!state.data?.boards.find((board) => board.sourceId === sourceId)?.revision;
    setBusy(sourceId);
    setError(null);
    setNotice("");
    try {
      await client.publishContribution(projectId, sourceId);
      if (!isCurrent()) return;
      await cache.invalidateQueries({ queryKey: ["project", projectId] });
      if (!isCurrent()) return;
      setNotice(replacing ? "Board update published." : "Design files shared with Contributors.");
      setConfirm(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
      if (isCurrent()) await state.refetch();
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
          Shared previews are view-only. For each board below, you can also share design files with
          all project Contributors. They edit a separate copy, then publish an update.
        </p>
        <details className="fd-board-files-details">
          <summary>What files are shared?</summary>
          <dl className="fd-board-file-inclusions">
            <div>
              <dt>Included</dt>
              <dd>KiCad PCB and saved schematic, when available</dd>
            </div>
            <div>
              <dt>Not included</dt>
              <dd>Chats, scripts, other project files, custom libraries and external 3D assets</dd>
            </div>
            <div>
              <dt>Access</dt>
              <dd>Owner and Contributors only</dd>
            </div>
          </dl>
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
                  <div className="fd-board-file-heading">
                    <strong>{b.name}</strong>
                    <span className="fd-board-file-status" data-shared={!!b.revision}>
                      {b.revision ? "Contributors can edit a copy" : "View only"}
                    </span>
                  </div>
                  {b.revision && (b.publishedBy || b.publishedAt) && (
                    <small className="fd-board-file-updated">
                      {b.publishedBy && <span>Updated by {b.publishedBy}</span>}
                      {b.publishedAt && (
                        <time dateTime={b.publishedAt}>
                          {new Date(b.publishedAt).toLocaleString(undefined, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </time>
                      )}
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
                    <Button ref={rememberAction(b.sourceId)} size="sm" disabled={!!busy} onClick={() => { setNotice(""); setError(null); setConfirm(b.sourceId); }}>
                      {b.revision ? "Publish update" : "Share files"}
                    </Button>
                  )
                ) : !b.available ? (
                  <small>No local design files</small>
                ) : b.revision && state.data?.role !== "viewer" ? (
                  <Button
                    ref={rememberAction(b.sourceId)}
                    size="sm"
                    disabled={!!busy}
                    onClick={async () => {
                      setBusy(b.sourceId);
                      setError(null);
                      try {
                        const p = await client.importTeamBoard(state.data!.projectId, b.id);
                        if (!isCurrent()) return;
                        await cache.invalidateQueries();
                        if (!isCurrent()) return;
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
          <section className="fd-contribution-confirm" ref={confirmationRef} tabIndex={-1} aria-labelledby={confirmationTitleId}>
            <strong id={confirmationTitleId}>
              {confirmedBoard?.revision
                ? `Replace the shared version of ${confirmedBoard.name}?`
                : `Share design files for ${confirmedBoard?.name ?? "this board"}?`}
            </strong>
            <p>
              {confirmedBoard?.revision
                ? "Your local PCB and saved schematic will replace the shared board files."
                : "Contributors will be able to download this board’s PCB and saved schematic."}{" "}
              Its saved previews, 3D model and checks will also update on the shared page.
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
