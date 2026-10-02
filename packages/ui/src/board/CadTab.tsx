import { useCallback, useEffect, useState } from "react";
import { FabCadView, type CadRuntimeBridge, type CadRuntimeState } from "@fabdesk/protocol";
import { useCoreClient } from "@fabdesk/client-core";
import { Button, EmptyState, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";

/**
 * The fab_cad web UI is served by the loopback bridge, an origin other than the renderer's, so
 * allow-same-origin keeps it at the bridge's own origin (its `/ws` trusts same-origin pages; it
 * still cannot reach the renderer's) and allow-scripts runs the SPA. No top navigation and no popups
 * that escape the sandbox; downloads for model exports, modals for its confirm dialogs.
 */
export const CAD_FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-downloads allow-modals";

type ViewState =
  | { status: "loading" }
  | { status: "ready"; view: FabCadView }
  | { status: "failed"; error: string };

/** The fab_cad web UI on the project's live FreeCAD session: edits by the agent show up here as they happen. */
export function CadTab() {
  const client = useCoreClient();
  const projectId = useUiStore((s) => s.activeProjectId);
  const runtimeBridge = (window as unknown as { fabdesk?: CadRuntimeBridge }).fabdesk;
  const [runtime, setRuntime] = useState<CadRuntimeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<ViewState>({ status: "loading" });

  const load = useCallback(async () => {
    useEffect(() => {
      if (!runtimeBridge || !busy) return;
      const timer = setInterval(() => {
        void runtimeBridge.cadRuntimeState().then(setRuntime);
      }, 500);
      return () => clearInterval(timer);
    }, [runtimeBridge, busy]);

    if (!projectId) return;
    setState({ status: "loading" });
    try {
      if (runtimeBridge?.prepareCadRuntime) {
        const status = await runtimeBridge.prepareCadRuntime();
        setRuntime(status);
        if (status.status !== "ready") return;
      }
      const res = (await client.callTool("cad_view", { projectId })) as {
        json?: unknown;
        result?: unknown;
      };
      const parsed = FabCadView.safeParse(res.json ?? res.result);
      setState(
        parsed.success
          ? { status: "ready", view: parsed.data }
          : { status: "failed", error: "unexpected cad_view response" },
      );
    } catch (e) {
      setState({ status: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }, [client, projectId, runtimeBridge]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!projectId) return <EmptyState title="No project selected" />;
  if (runtime && runtime.status !== "ready") {
    const active = busy || runtime.status === "downloading" || runtime.status === "verifying";
    const offer = runtime.offer;
    const size = (n: number) => `${(n / 1048576).toFixed(1)} MiB`;
    return (
      <EmptyState
        title={
          runtime.status === "consent"
            ? "Download the CAD runtime?"
            : "CAD runtime is not installed"
        }
      >
        <p>CAD needs our API-capable FreeCAD runtime. Your PCB workspace remains available.</p>
        {offer && (
          <p className="mt-2">
            Version {offer.version} · {offer.target} · macOS {offer.minimumOS}+<br />
            Download: {size(offer.downloadBytes)} ({offer.downloadBytes.toLocaleString()} bytes).
            Installed: {size(offer.installedBytes)} ({offer.installedBytes.toLocaleString()} bytes).
            <br />
            Source:{" "}
            <a href={offer.sourceUrl} target="_blank" rel="noreferrer">
              fabPlane/FreeCAD on GitHub
            </a>
          </p>
        )}
        {runtime.message && <p className="mt-2">{runtime.message}</p>}
        {active && (
          <p>
            {runtime.status === "verifying"
              ? "Verifying signature and installing…"
              : runtime.status !== "downloading"
                ? "Waiting for download approval…"
                : `Downloading ${size(runtime.received ?? 0)}…`}
          </p>
        )}
        <div className="mt-3 flex gap-2 justify-center">
          {offer && !active && (
            <Button
              size="sm"
              onClick={async () => {
                setBusy(true);
                try {
                  setRuntime(await runtimeBridge!.downloadCadRuntime());
                  await load();
                } finally {
                  setBusy(false);
                }
              }}
            >
              Download and install
            </Button>
          )}
          {!active && runtime.status !== "unsupported" && !offer && (
            <Button size="sm" onClick={() => void load()}>
              Retry
            </Button>
          )}
          {runtime.status !== "unsupported" && (
            <Button
              size="sm"
              onClick={async () => {
                await runtimeBridge!.cancelCadRuntime();
                setRuntime(await runtimeBridge!.deferCadRuntime());
              }}
            >
              {active ? "Cancel" : "Later"}
            </Button>
          )}
        </div>
      </EmptyState>
    );
  }
  if (state.status === "loading")
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  const retry = (
    <Button size="sm" onClick={() => void load()}>
      Retry
    </Button>
  );
  if (state.status === "failed")
    return (
      <EmptyState title="FreeCAD is not available" action={retry}>
        {state.error}
        <div className="mt-2">
          Start the FabPlane CAD bridge with `bun run dev:cad`, or install the FreeCAD backend.
        </div>
      </EmptyState>
    );
  if (!state.view.uiUrl)
    return (
      <EmptyState title="No CAD UI on this bridge" action={retry}>
        The FreeCAD session for this project is running (document {state.view.document}), but the
        bridge at {state.view.bridgeUrl} serves no web UI. Build fab_cad&apos;s apps/web and set
        STATIC_DIR on the bridge.
      </EmptyState>
    );
  return (
    <iframe
      title="FreeCAD"
      src={state.view.uiUrl}
      sandbox={CAD_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-panel"
      data-testid="cad-frame"
    />
  );
}
