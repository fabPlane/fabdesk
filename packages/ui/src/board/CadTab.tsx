import { useEffect, useMemo, useState } from "react";
import { type CadRuntimeBridge } from "@fabdesk/protocol";
import { CadSession, type CadSessionState, useCoreClient } from "@fabdesk/client-core";
import { Button, EmptyState, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { EnclosurePanel } from "./EnclosurePanel";

/**
 * The fab_cad web UI is served by the loopback bridge, an origin other than the renderer's, so
 * allow-same-origin keeps it at the bridge's own origin (its `/ws` trusts same-origin pages; it
 * still cannot reach the renderer's) and allow-scripts runs the SPA. No top navigation and no popups
 * that escape the sandbox; downloads for model exports, modals for its confirm dialogs.
 */
export const CAD_FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-downloads allow-modals";

/** The CAD runtime is optional and installed only after native download consent. */
export function CadTab() {
  const client = useCoreClient();
  const projectId = useUiStore((s) => s.activeProjectId);
  const runtimeBridge = (window as unknown as { fabdesk?: CadRuntimeBridge }).fabdesk;
  const [state, setState] = useState<CadSessionState>({
    runtime: null,
    busy: true,
    view: null,
    error: null,
  });
  const session = useMemo(
    () =>
      new CadSession(
        runtimeBridge,
        async () => {
          const res = await client.callTool("cad_view", { projectId });
          return "json" in res ? res.json : res.result;
        },
        setState,
      ),
    [client, projectId, runtimeBridge],
  );

  useEffect(() => {
    if (!projectId) return;
    session.resume();
    void session.refresh();
    const timer = setInterval(() => void session.poll(), 500);
    return () => {
      clearInterval(timer);
      session.dispose();
    };
  }, [session, projectId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EnclosurePanel />
      <div className="min-h-0 flex-1">
        <CadScreen projectSelected={Boolean(projectId)} state={state} session={session} />
      </div>
    </div>
  );
}

/** Presentational surface shared by the desktop and local state previews. */
export function CadScreen({
  projectSelected,
  state,
  session,
}: {
  projectSelected: boolean;
  state: CadSessionState;
  session: Pick<CadSession, "refresh" | "install" | "cancel">;
}) {
  if (!projectSelected) return <EmptyState title="No project selected" />;
  const { runtime, busy, view, error } = state;
  const retry = (
    <Button size="sm" disabled={busy} onClick={() => void session.refresh(true)}>
      Retry connection
    </Button>
  );
  if (runtime && runtime.status !== "ready") {
    const active = busy || runtime.status === "downloading" || runtime.status === "verifying";
    const offer = runtime.offer;
    const title =
      runtime.status === "unsupported"
        ? "CAD isn’t supported on this device"
        : runtime.status === "error"
          ? "CAD setup needs attention"
          : runtime.status === "downloading"
            ? "Downloading the CAD bridge"
            : runtime.status === "verifying"
              ? "Preparing your CAD workspace"
              : "Add CAD to your workspace";
    const size = (n: number) => `${(n / 1048576).toFixed(1)} MiB`;
    const percent =
      offer && runtime.status === "downloading"
        ? Math.min(100, Math.floor(((runtime.received ?? 0) / offer.downloadBytes) * 100))
        : null;
    return (
      <EmptyState title={title} icon={<span className="text-3xl">◇</span>}>
        <p>
          Design enclosures and mechanical parts with the optional FreeCAD bridge. Your PCB
          workspace remains available.
        </p>
        {offer && (
          <div className="mt-4 rounded-lg border border-border bg-panel p-3 text-left">
            <p>
              Download {size(offer.downloadBytes)} · Uses {size(offer.installedBytes)} on disk
            </p>
            <p className="mt-1">Apple Silicon · macOS {offer.minimumOS} or later</p>
            <a className="underline" href={offer.sourceUrl} target="_blank" rel="noreferrer">
              Official FreeCAD runtime on GitHub
            </a>
            <p className="mt-1 break-words text-xs">Version {offer.version}</p>
          </div>
        )}
        {runtime.message && (
          <p className="mt-3" role="alert">
            {runtime.message}
          </p>
        )}
        {error && (
          <p className="mt-3" role="alert">
            {error}
          </p>
        )}
        {active && (
          <div className="mt-3" role="status" aria-live="polite">
            {percent !== null ? (
              <>
                <progress
                  className="w-full"
                  value={percent}
                  max={100}
                  aria-label="CAD download progress"
                />
                <p>
                  {percent}% · {size(runtime.received ?? 0)} downloaded
                </p>
              </>
            ) : runtime.status === "verifying" ? (
              "Checking signature and installing…"
            ) : (
              "Preparing CAD setup…"
            )}
          </div>
        )}
        {offer && !active && (
          <p className="mt-3">
            You’ll be asked to approve the download before installation begins.
          </p>
        )}
        <div className="mt-4 flex justify-center gap-2">
          {!active && runtime.status !== "unsupported" && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => void (offer ? session.install() : session.refresh())}
            >
              {offer
                ? runtime.status === "error"
                  ? "Retry installation"
                  : "Install CAD bridge"
                : "Retry setup"}
            </Button>
          )}
          {runtime.status !== "unsupported" && (
            <Button size="sm" variant="secondary" onClick={() => void session.cancel()}>
              {active ? "Cancel" : "Later"}
            </Button>
          )}
        </div>
      </EmptyState>
    );
  }
  if (error)
    return (
      <EmptyState
        title={
          runtime?.status === "ready" ? "CAD bridge connection lost" : "CAD bridge is unavailable"
        }
        action={retry}
      >
        <p role="alert">{error}</p>
        <p className="mt-2">
          {runtime?.status === "ready"
            ? "Your CAD runtime is installed. Retry to reconnect."
            : "Check that your CAD bridge is running and reachable."}
        </p>
      </EmptyState>
    );
  if (busy || !view)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3" role="status">
        <Spinner />
        <span className="text-sm text-muted">Connecting to CAD…</span>
      </div>
    );
  if (!view.uiUrl)
    return (
      <EmptyState title="This CAD bridge has no viewer" action={retry}>
        Your FreeCAD session is running, but this bridge does not provide a CAD viewer. Update the
        bridge and retry.
      </EmptyState>
    );
  return (
    <iframe
      title="FreeCAD"
      src={view.uiUrl}
      sandbox={CAD_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-panel"
      data-testid="cad-frame"
    />
  );
}
