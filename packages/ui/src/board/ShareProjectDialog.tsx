import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  errorPayload,
  useAuthStore,
  useBoardSources,
  useCore,
  useProject,
} from "@fabdesk/client-core";
import {
  sharedProjectUrl,
  type ProjectShareSnapshot,
  type ProjectShareState,
} from "@fabdesk/protocol";
import { Button, Dialog, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
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
  const account = useAuthStore((s) => s.state?.principal?.subject ?? s.state?.status ?? "unknown");
  const queryKey = ["project-share", client.baseUrl, projectId, account];
  const settings = useQuery({
    queryKey,
    queryFn: () => client.getProjectShare(projectId),
    retry: false,
    staleTime: 0,
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });
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
  const close = () => {
    if (!busy) onClose();
  };
  const save = async () => {
    if (!confirmed || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
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
    try {
      if (host.copyText) await host.copyText(link);
      else await navigator.clipboard.writeText(link);
      setNotice({ message: "Link copied.", state: stateKey(saved) });
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
        <fieldset className="fd-share-visibility" disabled={busy || !confirmed}>
          <legend>Project visibility{settings.isError ? " · not checked" : ""}</legend>
          {(
            [
              { value: "private", title: "Private", detail: "Only you. Link sharing is disabled." },
              {
                value: "unlisted",
                title: "Anyone with the link",
                detail: "Anyone with the link can view the shared page.",
              },
            ] as const
          ).map((option) => (
            <label key={option.value} data-selected={selected === option.value}>
              <input
                type="radio"
                name="project-visibility"
                value={option.value}
                checked={selected === option.value}
                onChange={() => {
                  setChoice(option.value);
                  setNotice(null);
                }}
              />
              <span>
                <strong>{option.title}</strong>
                <small>{option.detail}</small>
              </span>
            </label>
          ))}
        </fieldset>
        {settings.isPending && (
          <p role="status" className="fd-share-muted">
            <Spinner />
            Checking sharing settings…
          </p>
        )}
        <section className="fd-share-link-section">
          <h3>Shared link</h3>
          {link ? (
            <>
              <div className="fd-share-link-row">
                <input
                  aria-label="Shared project link"
                  readOnly
                  value={link}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button disabled={busy} onClick={() => void copy()}>
                  <Icon name="copy" width={16} height={16} />
                  Copy link
                </Button>
              </div>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  void host.openExternal(link);
                }}
              >
                <Icon name="externalLink" width={16} height={16} />
                Open shared page
              </Button>
            </>
          ) : (
            <div className="fd-share-link-empty">
              {!confirmed
                ? "A link is available after sharing settings can be checked."
                : selected === "private"
                  ? changed
                    ? "Save changes to disable the current shared link."
                    : "No link is available while the project is private."
                  : "Publish the shared page to create a link."}
            </div>
          )}
        </section>
        <section className="fd-share-explainer">
          <h3>What visitors see</h3>
          <p>
            {count !== undefined ? `${count} ${count === 1 ? "board" : "boards"}. ` : ""}Saved
            previews, saved 3D models and PCB check results, where available.
          </p>
          <small>
            Chats, local folders and native design files stay private. Up to 10 MiB per model and 20
            MiB total.
          </small>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !project.data || sources.isError}
            onClick={() => void showPreview()}
          >
            Preview shared page
          </Button>
        </section>
        {selected === "unlisted" && (
          <p className="fd-share-muted">
            {saved?.visibility === "unlisted" && confirmed
              ? `Published ${new Date(saved.publishedAt).toLocaleString()}. `
              : ""}
            Local changes appear only after you update the shared page. This link won’t appear in
            Explore.
          </p>
        )}
        {changed && selected === "private" && (
          <p className="fd-share-muted">
            Save to disable the current shared link. Copies already downloaded by visitors cannot be
            recalled.
          </p>
        )}
        {payload && (
          <div className="fd-share-error" role="alert">
            <strong>
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
          <Button variant="ghost" disabled={busy} onClick={onDownload}>
            <Icon name="download" width={16} height={16} />
            Download review ZIP
          </Button>
          <div>
            {confirmed && (changed || selected === "unlisted") && (
              <Button variant="primary" disabled={busy} onClick={() => void save()}>
                {busy ? (
                  <>
                    <Spinner />
                    Saving…
                  </>
                ) : selected === "private" ? (
                  "Save changes"
                ) : saved.visibility === "unlisted" ? (
                  "Update shared page"
                ) : (
                  "Publish shared page"
                )}
              </Button>
            )}
            <Button
              variant={!confirmed || (!changed && selected === "private") ? "primary" : "secondary"}
              disabled={busy}
              onClick={close}
            >
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
