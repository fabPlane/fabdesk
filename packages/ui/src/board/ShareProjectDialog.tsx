import { useEffect, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  cloudAccountId,
  errorPayload,
  useAuthStore,
  useBoardSources,
  useCore,
  useProject,
  useProjectShareSettings,
} from "@fabdesk/client-core";
import {
  sharedProjectUrl,
  type ProjectShareSnapshot,
  type ProjectShareState,
} from "@fabdesk/protocol";
import { Button, Dialog, Select, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { DisclosureSummary } from "../components/DisclosureSummary";
import { useUiStore } from "../stores/ui";
import { ContributionsDialog } from "./ContributionsDialog";
import { SharedProjectContent } from "./SharedProjectContent";
import "./project-sharing.css";

type Props = { projectId: string; onClose: () => void; onDownload: () => void };
class ClipboardCopyError extends Error {}
/** Mounted per opening: drafts never masquerade as remotely saved visibility. */
export function ShareProjectDialog(props: Props) {
  const account = useAuthStore(s => cloudAccountId(s.state));
  return <ShareProjectForAccount key={account ?? "signed-out"} {...props} account={account} />;
}
function ShareProjectForAccount({ projectId, onClose, onDownload, account }: Props & { account: string | null }) {
  const { client, host } = useCore(),
    cache = useQueryClient();
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const project = useProject(projectId),
    sources = useBoardSources(projectId);
  const appOrigin = useAuthStore((s) => s.state?.dashboardUrl);
  const settings = useProjectShareSettings(projectId);
  const accessId = useId();
  const { queryKey } = settings;
  const [copyFeedback, setCopyFeedback] = useState<{ link: string; state: string } | null>(null);
  useEffect(() => {
    if (!copyFeedback) return;
    const timer = setTimeout(() => setCopyFeedback(null), 3_000);
    return () => clearTimeout(timer);
  }, [copyFeedback]);
  const [choice, setChoice] = useState<"private" | "restricted" | "unlisted" | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState<{ message: string; state: string } | null>(null);
  const [editingBoards, setEditingBoards] = useState(false);
  const [preview, setPreview] = useState<ProjectShareSnapshot | null>(null);
  const saved = settings.data,
    selected = choice ?? saved?.visibility ?? "private";
  const confirmed = !!saved && !settings.isError;
  const link =
    confirmed && saved.visibility !== "private" && selected === saved.visibility
      ? saved.visibility === "unlisted" ? sharedProjectUrl(saved.shareId, appOrigin) : `${new URL(appOrigin ?? "https://app.fabplane.com").origin}/projects/${saved.projectId}`
      : null;
  const changed = confirmed && selected !== saved.visibility;
  const stateKey = (state: ProjectShareState) =>
    state.visibility === "private" ? "private" : `${state.visibility}:${state.visibility === "restricted" ? state.projectId : state.shareId}:${state.revision}`;
  const copied =
    !!copyFeedback &&
    confirmed &&
    copyFeedback.link === link &&
    copyFeedback.state === stateKey(saved);
  const close = () => {
    if (!busy) onClose();
  };
  const save = async () => {
    if (!confirmed || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setCopyFeedback(null);
    try {
      const result: ProjectShareState =
        selected === "private"
          ? await client.disableProjectShare(projectId)
          : await client.publishProjectShare(projectId,
              changed || saved?.visibility === "private" ? selected : undefined,
              { updateOnly: !changed && saved?.visibility !== "private" });
      if (!mounted.current || cloudAccountId(useAuthStore.getState().state) !== account) return;
      cache.setQueryData(queryKey, result);
      setChoice(null);
      setNotice({
        state: stateKey(result),
        message:
          result.visibility === "private"
            ? "Project sharing is off."
            : result.visibility === "restricted" ? "Shared page updated. Only invited people can open it." : "Shared page updated. Anyone with the link can view it.",
      });
    } catch (failure) {
      if (!mounted.current || cloudAccountId(useAuthStore.getState().state) !== account) return;
      setError(failure);
      // A timed-out request might have succeeded. Reconcile before allowing another mutation.
      await settings.refetch();
    } finally {
      setBusy(false);
    }
  };
  const showPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await client.previewProjectShare(projectId));
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!link || !saved) return;
    setError(null);
    setNotice(null);
    setCopyFeedback(null);
    try {
      if (host.copyText) await host.copyText(link);
      else await navigator.clipboard.writeText(link);
      setCopyFeedback({ link, state: stateKey(saved) });
    } catch {
      setError(new ClipboardCopyError("Could not copy the link. Select the address and copy it manually."));
    }
  };
  const failure = error ?? settings.error;
  const payload = failure ? errorPayload(failure) : null;
  const count = sources.data?.sources.length;
  if (project.data?.manifest.contributionSource) return <ContributionsDialog projectId={projectId} onClose={onClose} />;
  if (editingBoards) return <ContributionsDialog projectId={projectId} onClose={()=>setEditingBoards(false)} />;
  return (
    <>
      <Dialog
        open
        onClose={close}
        closeDisabled={busy}
        title="Share project"
        className="fd-share-dialog"
      >
        <p className="fd-share-project-name">{project.data?.name ?? "Project"}</p>
        <div className="fd-share-access-row">
          <label htmlFor={accessId}>Who can view</label>
          <Select
            id={accessId}
            aria-describedby={`${accessId}-hint`}
            disabled={busy || !confirmed}
            value={confirmed ? selected : "unknown"}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value !== "private" && value !== "restricted" && value !== "unlisted") return;
              setChoice(value);
              setNotice(null);
              setCopyFeedback(null);
            }}
          >
            {!confirmed && (
              <option value="unknown">
                {settings.isPending ? "Checking access…" : "Access unavailable"}
              </option>
            )}
            <option value="private">Not shared</option>
            <option value="restricted">Invited people</option>
            <option value="unlisted">Anyone with the link</option>
          </Select>
        </div>
        <p id={`${accessId}-hint`} className="fd-share-access-hint" role="status">
          {!confirmed
            ? settings.isPending
              ? "Checking sharing settings…"
              : "Retry below to check link access."
            : selected === "private"
              ? changed
                ? "Save to turn off online viewing and design-file access. Downloaded copies remain."
                : "Online viewing and design-file sharing are off."
              : selected === "restricted" ? "Only you and invited people. Sign-in is required."
              : link
                ? "Anyone with the link can view. No sign-in needed."
                : "Create a link to let others view this project."}
        </p>
        {link && (
          <section className="fd-share-link-section" aria-label="Shared link">
            <div className="fd-share-link-row">
              <input
                aria-label="Shared project link"
                readOnly
                value={link}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button
                variant={copied ? "secondary" : "primary"}
                disabled={busy}
                className="fd-share-copy-button"
                data-copied={copied}
                onClick={() => void copy()}
              >
                <Icon name={copied ? "check" : "copy"} width={16} height={16} />
                <span aria-live="polite" aria-atomic="true">
                  {copied ? "Copied!" : "Copy link"}
                </span>
              </Button>
            </div>
            <div className="fd-share-link-actions">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  void host.openExternal(link);
                }}
              >
                <Icon name="externalLink" width={16} height={16} />
                Open shared page
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
                if (!saved || saved.visibility === "private") return;
                const query = saved.visibility === "restricted"
                  ? `share=${encodeURIComponent(saved.projectId)}`
                  : `shareLink=${encodeURIComponent(saved.shareId)}`;
                void host.openExternal(`${new URL(appOrigin ?? "https://app.fabplane.com").origin}/projects?${query}`);
              }}>Manage people online</Button>
            </div>
          </section>
        )}
        <p className="fd-share-scope">
          The shared page shows saved previews, 3D models and PCB checks.
          {selected !== "private" && (
            <span>Local edits aren’t shared automatically.</span>
          )}
          {confirmed && saved.visibility !== "private" && (
            <span>Page updated {new Date(saved.publishedAt).toLocaleString()}.</span>
          )}
        </p>
        <section className="fd-share-files-section" aria-labelledby={`${accessId}-files`}>
          <div>
            <h3 id={`${accessId}-files`}>Board design files</h3>
            <p>
              {!confirmed
                ? "Check project sharing before managing design files."
                : saved.visibility !== "private"
                  ? "Choose which boards Contributors can download and update."
                  : "Share the project first to enable design-file sharing."}
            </p>
          </div>
          <Button size="sm" disabled={busy || !confirmed || saved.visibility === "private"} onClick={()=>setEditingBoards(true)}>
            Manage files
          </Button>
        </section>
        <details className="fd-share-more">
          <DisclosureSummary label="More options" icon="more" variant="compact" />
          <div className="fd-share-more-actions">
            <Button
              size="sm"
              disabled={busy || !project.data || sources.isError}
              onClick={() => void showPreview()}
            >
              Preview shared page
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onDownload}>
              <Icon name="download" width={15} height={15} />
              Download review ZIP
            </Button>
          </div>
          <p className="fd-share-muted">
            {count !== undefined ? `${count} ${count === 1 ? "board" : "boards"}. ` : ""}
            Chats stay private. Shared pages aren’t listed in Explore.
          </p>
        </details>
        {payload && (
          <div className="fd-share-error" role="alert">
            <strong className="fd-share-error-title">
              <Icon name="warning" width={17} height={17} />
              {payload.code === "cloud_signed_out"
                ? "Sign in to share this project"
                : settings.isError && !error
                  ? "Sharing settings could not be checked"
                  : "Could not complete this action"}
            </strong>
            <p>
              {payload.code === "cloud_signed_out"
                ? "Publishing a shared page needs your fabPlane account."
                : payload.message}
            </p>
            <div>
              {payload.code === "cloud_signed_out" && (
                <Button
                  size="sm"
                  onClick={() => {
                    useUiStore.getState().setProfileOpen(true, account ? "expired" : "sharing", true);
                  }}
                >
                  {account ? "Sign in again" : "Sign in"}
                </Button>
              )}
              {payload.code !== "cloud_signed_out" && <Button
                size="sm"
                disabled={busy || settings.isFetching}
                onClick={() => {
                  if (error instanceof ClipboardCopyError && link) {
                    void copy();
                    return;
                  }
                  setError(null);
                  void settings.refetch();
                }}
              >
                {error instanceof ClipboardCopyError && link ? "Try copying again" : "Retry"}
              </Button>}
            </div>
          </div>
        )}
        {notice && confirmed && notice.state === stateKey(saved) && (
          <p role="status" className="fd-share-notice">
            {notice.message}
          </p>
        )}
        <footer className="fd-share-footer">
          <div>
            {confirmed && (changed || selected !== "private") && (
              <Button
                variant={link ? "secondary" : "primary"}
                disabled={busy}
                onClick={() => void save()}
              >
                {busy ? (
                  <>
                    <Spinner />
                    Working…
                  </>
                ) : selected === "private" ? (
                  "Save changes"
                ) : saved.visibility !== "private" ? (
                  "Update shared page"
                ) : (
                  selected === "restricted" ? "Publish for invited viewers" : "Create link"
                )}
              </Button>
            )}
            <Button variant="ghost" disabled={busy} onClick={close}>
              Done
            </Button>
          </div>
        </footer>
      </Dialog>
      {preview && (
        <Dialog
          open
          onClose={() => setPreview(null)}
          title="Shared page preview"
          className="fd-shared-project-dialog"
        >
          <p className="fd-share-muted">Local preview · nothing has been published.</p>
          <SharedProjectContent snapshot={preview} />
        </Dialog>
      )}
    </>
  );
}
