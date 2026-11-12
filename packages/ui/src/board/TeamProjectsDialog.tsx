import type { ProjectDetail } from "@fabdesk/protocol";
import { DownloadedCopyDialog } from "./DownloadedCopyDialog";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cloudAccountId, useAuthStore, errorPayload, useCoreClient } from "@fabdesk/client-core";
import { Button, Dialog, Spinner, Select } from "../components/ui";
import { useUiStore } from "../stores/ui";
import "./project-sharing.css";
export function TeamProjectsDialog(props: { onClose: () => void; initialProjectId?: string }) {
  const account = useAuthStore(s => cloudAccountId(s.state));
  return <TeamProjectsForAccount key={account ?? "signed-out"} {...props} account={account} />;
}

function TeamProjectsForAccount({
  account,
  onClose,
  initialProjectId,
}: {
  onClose: () => void;
  initialProjectId?: string;
  account: string | null;
}) {
  const client = useCoreClient(),
    cache = useQueryClient();
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isCurrent = () => mounted.current && cloudAccountId(useAuthStore.getState().state) === account;
  const [downloaded, setDownloaded] = useState<ProjectDetail | null>(null);
  const projects = useQuery({
    queryKey: ["team-projects", client.baseUrl, account],
    queryFn: () => client.listTeamProjects(),
    enabled: !!account,
    retry: false,
    refetchInterval: 5000,
  });
  const [selected, setSelected] = useState(initialProjectId ?? ""),
    [busy, setBusy] = useState<string | null>(null),
    [error, setError] = useState<unknown>(null);
  const items = projects.isError
    ? []
    : (projects.data?.projects.filter((p) => p.publishedAt && p.role !== "viewer") ?? []);
  const id =
    selected === initialProjectId && !items.some((p) => p.id === initialProjectId)
      ? null
      : (items.find((p) => p.id === selected)?.id ?? items[0]?.id ?? null);
  const boards = useQuery({
    queryKey: ["team-boards", client.baseUrl, id, account],
    queryFn: () => client.listTeamBoards(id!),
    enabled: !!account && !!id,
    refetchInterval: 5000,
  });
  const open = async (boardId: string) => {
    if (!id) return;
    setBusy(boardId);
    setError(null);
    try {
      const p = await client.importTeamBoard(id, boardId);
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
  };
  const failure = error ?? projects.error ?? boards.error;
  const expiredSession = !!account && errorPayload(failure).code === "cloud_signed_out";
  return (
    <>
      <Dialog
        open
        title="Projects shared with me"
        onClose={onClose}
        closeDisabled={!!busy}
        className="fd-share-dialog"
      >
        <p className="fd-share-muted">
          Use the same account you accepted the invitation with. Open an editable board as a
          separate local project; use Publish in the copy’s toolbar to send an update.
        </p>
        {(!account || initialProjectId || failure) && <div className="fd-profile-callout">
          <p>{expiredSession ? "Your session expired. Sign in again to refresh shared projects." : account ? "Need another account? Use the email address the invitation was sent to." : "Sign in to your fabPlane account to see projects shared with you."}</p>
          <Button size="sm" onClick={() => useUiStore.getState().setProfileOpen(true, expiredSession ? "expired" : "invitation")}>{expiredSession ? "Sign in again" : account ? "Switch account" : "Sign in"}</Button>
        </div>}
        {initialProjectId && projects.data && !items.some((p) => p.id === initialProjectId) && (
          <p role="alert">
            This project is unavailable for editing with your desktop account. Sign in with the
            invited account, accept its Contributor invitation online, then retry.
          </p>
        )}
        {failure && (
          <p role="alert" className="fd-share-error">
            {errorPayload(failure).message}
            <Button
              size="sm"
              onClick={() => {
                setError(null);
                void projects.refetch();
                if (id) void boards.refetch();
              }}
            >
              Retry
            </Button>
          </p>
        )}
        {!account ? null : projects.isPending ? (
          <p role="status">
            <Spinner />
            Loading projects…
          </p>
        ) : !items.length ? (
          <p>
            No editable projects yet. Accept a Contributor invitation, or publish editable boards
            from a project you own. View-only projects are available online.
          </p>
        ) : (
          <>
            <label className="fd-contribution-project">
              Project
              <Select
                aria-label="Shared project"
                value={id ?? ""}
                disabled={!!busy}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setError(null);
                }}
              >
                {!id && <option value="" disabled>Select a shared project</option>}
                {items.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.role === "owner" ? " · Owned by you" : ""}
                  </option>
                ))}
              </Select>
            </label>
            {!id ? (
              <p>Select an available project to see its boards.</p>
            ) : boards.isPending ? (
              <p role="status">Loading boards…</p>
            ) : (
              <ul className="fd-contribution-list">
                {!boards.isError &&
                  boards.data?.boards.map((b) => (
                    <li key={b.id}>
                      <div>
                        <strong>{b.name}</strong>
                        <small>
                          {b.revision
                            ? `Published by ${b.publishedBy} · ${new Date(b.publishedAt!).toLocaleString()}`
                            : "The owner hasn’t shared editable files for this board."}
                        </small>
                      </div>
                      <Button
                        size="sm"
                        disabled={!!busy || !b.revision}
                        onClick={() => void open(b.id)}
                      >
                        {busy === b.id ? "Opening…" : "Open editable copy"}
                      </Button>
                    </li>
                  ))}
              </ul>
            )}
          </>
        )}
        <p className="fd-share-muted">
          Includes the KiCad PCB and saved schematic where available. Custom libraries, external 3D
          assets and chats aren’t included. Your existing files are kept.
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
          onClose={() => setDownloaded(null)}
          onOpened={onClose}
        />
      )}
    </>
  );
}
