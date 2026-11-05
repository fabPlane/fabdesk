import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { type CadRuntimeBridge } from "@fabdesk/protocol";
import { CadSession, type CadSessionState, useCoreClient } from "@fabdesk/client-core";
import { Button, EmptyState, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";
const MechanicalWorkspace = lazy(() =>
  import("./mechanical/MechanicalWorkspace").then((m) => ({ default: m.MechanicalWorkspace })),
);

/**
 * The fab_cad web UI is served by the loopback bridge, an origin other than the renderer's, so
 * allow-same-origin keeps it at the bridge's own origin (its `/ws` trusts same-origin pages; it
 * still cannot reach the renderer's) and allow-scripts runs the SPA. No top navigation and no popups
 * that escape the sandbox; downloads for model exports, modals for its confirm dialogs.
 */
export const CAD_FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-downloads allow-modals";

/** How often the kernel tree refreshes while a project is open (cad_kernels is cached server-side). */
export const CAD_KERNEL_TREE_POLL_MS = 15_000;

export function shouldShowCadKernelTree(
  projectId: string | null | undefined,
  tree: CadKernelTreeModel | null,
): boolean {
  return Boolean(projectId && tree);
}

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

  const [tree, setTree] = useState<CadKernelTreeModel | null>(null);
  useEffect(() => {
    setTree(null);
    if (!projectId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await client.callTool("cad_kernels", { projectId });
        const body = (res && typeof res === "object" && "result" in res ? res.result : res) as {
          json?: CadKernelTreeModel;
        };
        const json = body && typeof body === "object" && "json" in body ? body.json : undefined;
        if (!cancelled && json) setTree(json);
      } catch {
        if (!cancelled) setTree(null);
      }
    };
    void load();
    const timer = setInterval(() => void load(), CAD_KERNEL_TREE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, projectId]);

  const advanced = (
    <div className="flex h-full min-h-0">
      {shouldShowCadKernelTree(projectId, tree) ? <CadKernelTree model={tree!} /> : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
        {!state.busy &&
        !state.view &&
        state.runtime?.status !== "ready" &&
        state.runtime?.status !== "downloading" &&
        state.runtime?.status !== "verifying" ? (
          <details className="m-4 rounded-xl border border-border bg-panel p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Advanced CAD editing — optional
            </summary>
            <p className="mt-2 text-xs leading-5 text-muted">
              New enclosures can be generated and exported locally. Modifying an imported case or
              editing mechanical parts in FreeCAD requires the native CAD service.
            </p>
            <div className="mt-4">
              <CadScreen projectSelected={Boolean(projectId)} state={state} session={session} />
            </div>
          </details>
        ) : (
          <div className="min-h-0 flex-1">
            <CadScreen projectSelected={Boolean(projectId)} state={state} session={session} />
          </div>
        )}
      </div>
    </div>
  );
  if (!projectId) return <EmptyState title="Open a project to assemble your models" />;
  return (
    <Suspense
      fallback={
        <EmptyState title="Opening mechanical workspace">
          <Spinner />
        </EmptyState>
      }
    >
      <MechanicalWorkspace
        key={projectId}
        projectId={projectId}
        advanced={advanced}
        cadRuntime={state.runtime}
      />
    </Suspense>
  );
}

export type CadKernelTreeKernel = {
  id: string;
  label?: string;
  available?: boolean;
  experimental?: boolean;
  detail?: string;
};

export type CadKernelTreePart = {
  id: string;
  name: string;
  kernel: string;
  reason?: string;
  fallbacks?: Array<{ from: string; to: string; featureKind: string; error: string }>;
  step?: string;
};

export type CadKernelTreeModel = {
  kernels?: CadKernelTreeKernel[];
  store?: {
    parts?: CadKernelTreePart[];
    assembly?: { step: string; partIds: string[] } | null;
  };
};

export function CadKernelTree({ model }: { model: CadKernelTreeModel }) {
  const kernels = model.kernels ?? [];
  const parts = model.store?.parts ?? [];
  const assembly = model.store?.assembly;
  return (
    <aside
      className="flex h-full w-56 shrink-0 flex-col gap-3 overflow-auto border-r border-border bg-panel-2/40 p-3 text-xs"
      data-testid="cad-kernel-tree"
    >
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">Kernels</p>
        <ul className="mt-1 space-y-1">
          {kernels.map((k) => (
            <li key={k.id} data-kernel={k.id}>
              <span className="font-medium">{k.label ?? k.id}</span>
              {k.experimental ? <span className="ml-1 text-muted">experimental</span> : null}
              <span className="ml-1 text-muted">{k.available ? "ready" : "off"}</span>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">Parts</p>
        {parts.length === 0 ? (
          <p className="mt-1 text-muted">No kernel-built parts yet.</p>
        ) : (
          <ul className="mt-1 space-y-2">
            {parts.map((p) => (
              <li key={p.id} data-part={p.id}>
                <div className="font-medium">{p.name}</div>
                <div className="text-muted">
                  kernel {p.kernel}
                  {p.fallbacks?.length
                    ? ` · switched ${p.fallbacks.map((f) => `${f.from}→${f.to}`).join(", ")}`
                    : ""}
                </div>
                {p.reason ? <div className="text-muted">{p.reason}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      {assembly ? (
        <p className="text-muted" data-testid="cad-assembly">
          Assembly {assembly.step}
        </p>
      ) : null}
    </aside>
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
              : "Install advanced CAD editing";
    const size = (n: number) => `${(n / 1048576).toFixed(1)} MiB`;
    const percent =
      offer && runtime.status === "downloading"
        ? Math.min(100, Math.floor(((runtime.received ?? 0) / offer.downloadBytes) * 100))
        : null;
    return (
      <EmptyState title={title} icon={<span className="text-3xl">◇</span>}>
        <p>
          Edit mechanical parts with the optional FreeCAD bridge. Generating an enclosure and
          downloading STL/STEP files does not require installation.
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
