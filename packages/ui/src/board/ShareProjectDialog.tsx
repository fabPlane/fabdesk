import { useEffect, useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
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
import { SharedProjectContent } from "./SharedProjectContent";
import "./project-sharing.css";

type Props = { projectId: string; onClose: () => void; onDownload: () => void };
/** Mounted per opening: drafts never masquerade as remotely saved visibility. */
export function ShareProjectDialog({ projectId, onClose, onDownload }: Props) {
  const { client, host } = useCore(),
    cache = useQueryClient();
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
  const [choice, setChoice] = useState<"private" | "unlisted" | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [notice, setNotice] = useState<{ message: string; state: string } | null>(null);
  const [preview, setPreview] = useState<ProjectShareSnapshot | null>(null);
  const saved = settings.data,
    selected = choice ?? saved?.visibility ?? "private";
  const confirmed = !!saved && !settings.isError;
  const link =
    confirmed && saved.visibility === "unlisted" && selected === "unlisted"
      ? sharedProjectUrl(saved.shareId, appOrigin)
      : null;
  const changed = confirmed && selected !== saved.visibility;
  const stateKey = (state: ProjectShareState) =>
    state.visibility === "private" ? "private" : `${state.shareId}:${state.revision}`;
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
          : await client.publishProjectShare(projectId);
      cache.setQueryData(queryKey, result);
      setChoice(null);
      setNotice({
        state: stateKey(result),
        message:
          result.visibility === "private"
            ? "Link sharing is disabled."
            : "Shared page published. You can copy the link now.",
      });
    } catch (failure) {
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
      setError(new Error("Could not copy the link. Select the address and copy it manually."));
    }
  };
  const failure = error ?? settings.error;
  const payload = failure ? errorPayload(failure) : null;
  const count = sources.data?.sources.length;
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
              if (value !== "private" && value !== "unlisted") return;
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
            <option value="private">Private</option>
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
                ? "Save to disable the current link. Downloaded copies cannot be recalled."
                : "Only you. Link sharing is off."
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
          </section>
        )}
        <p className="fd-share-scope">
          Shared pages show saved previews, 3D models and checks. Design files and chats stay private.
          {selected === "unlisted" && (
            <span>Local edits appear after you update the shared page.</span>
          )}
        </p>
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
            Previews, models and checks are included where available. This link won’t appear in
            Explore.
            {confirmed && saved.visibility === "unlisted" && (
              <span>Published {new Date(saved.publishedAt).toLocaleString()}.</span>
            )}
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
                ? "Sign in to your fabPlane account to publish a shared page. You can preview it or download a review ZIP without signing in."
                : payload.message}
            </p>
            <div>
              {payload.code === "cloud_signed_out" && (
                <Button
                  size="sm"
                  onClick={() => {
                    close();
                    useUiStore.getState().setSettingsOpen(true, "auth");
                  }}
                >
                  Account settings
                </Button>
              )}
              <Button
                size="sm"
                disabled={busy || settings.isFetching}
                onClick={() => {
                  setError(null);
                  void settings.refetch();
                }}
              >
                Retry
              </Button>
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
            {confirmed && (changed || selected === "unlisted") && (
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
                ) : saved.visibility === "unlisted" ? (
                  "Update shared page"
                ) : (
                  "Create link"
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
