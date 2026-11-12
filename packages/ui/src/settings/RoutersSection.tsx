import type { RouterSnapshot } from "@fabdesk/protocol";
import {
  useCancelRouterInstall,
  useInstallRouter,
  usePatchSettings,
  useRouters,
  useSettings,
  useUninstallRouter,
} from "@fabdesk/client-core";
import { Badge, Button } from "../components/ui";
import {
  canRecheck,
  canUninstall,
  installProgressView,
  isEngine,
  isPreferred,
  primaryAction,
  primaryActionLabel,
  stateLabel,
  routerUsable,
} from "./routers";

function tone(router: RouterSnapshot): "success" | "warning" | "danger" | "neutral" {
  if (router.ready && router.runtime?.ready === false) return "warning";
  if (router.state === "bundled" || (router.state === "installed" && router.ready)) return "success";
  if (router.state === "installing" || router.state === "installed") return "warning";
  if (router.state === "failed") return "danger";
  return "neutral";
}

export function RoutersSection() {
  const routers = useRouters();
  const settings = useSettings();
  const patch = usePatchSettings();
  const install = useInstallRouter();
  const uninstall = useUninstallRouter();
  const cancel = useCancelRouterInstall();
  // Settings is the source of truth once loaded: a null there means "automatic", not "ask the router list".
  const preferred = settings.data ? (settings.data.preferredRouter ?? undefined) : routers.data?.preferredRouter;
  const rows = routers.data?.routers ?? [];
  // The install request stays pending for the whole download, so it must not disable the card's own
  // Cancel button (nor other routers' buttons); only the router being installed is held back.
  const busyBase = uninstall.isPending || cancel.isPending || patch.isPending;

  return (
    <div className="space-y-3">
      <p className="text-xs leading-5 text-muted">
        New projects keep today&apos;s default: Freerouting, falling back to fab_router when it is
        unavailable or fails. Install optional routers here, then pick one as the default or at
        Route Cinema. Agents pass <code className="font-mono">router</code> on{" "}
        <code className="font-mono">route_run</code>.
      </p>
      {routers.isError && (
        <div className="text-xs text-danger">{(routers.error as Error).message}</div>
      )}
      {rows.map((router) => {
        const action = primaryAction(router);
        const progress = installProgressView(router);
        const busy = busyBase || (install.isPending && install.variables === router.id);
        const preferredHere = isPreferred(router, preferred ?? undefined);
        return (
          <div key={router.id} className="rounded-lg border border-border p-3">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{router.displayName}</span>
              <Badge tone={tone(router)}>{stateLabel(router)}</Badge>
              {preferredHere && <Badge tone="accent">default</Badge>}
            </div>
            <p className="text-xs leading-5 text-muted">{router.description}</p>
            <ul className="mt-1 list-disc pl-4 text-[11px] leading-5 text-muted">
              {router.strengths.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <div className="mt-1 text-[11px] text-muted">
              {router.license}
              {router.version ? ` · ${router.version}` : ""}
            </div>
            {router.error && (
              <p role="alert" className="mt-2 text-xs text-danger" data-testid={`router-error-${router.id}`}>
                {router.state === "failed" ? "Install failed: " : "Last error: "}
                {router.error}
              </p>
            )}
            {router.notice && (
              <p className="mt-2 text-xs text-warning" data-testid={`router-notice-${router.id}`}>
                {router.notice}
              </p>
            )}
            {router.runtime?.ready === false && router.ready && <p className="mt-2 text-xs text-warning">{router.runtime.reason ?? "The active PCB backend could not verify this engine."}</p>}
            {(!router.ready || router.overriddenBy) && router.state !== "bundled" && router.state !== "installing" && (
              <p className="mt-2 text-xs text-muted">{router.installHint}</p>
            )}
            {progress && (
              <div className="mt-2" data-testid={`router-progress-${router.id}`}>
                <div
                  role="progressbar"
                  aria-label={`${router.displayName} install progress`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  {...(progress.fraction !== null ? { "aria-valuenow": Math.round(progress.fraction * 100) } : {})}
                  className="h-2 w-full overflow-hidden rounded bg-panel-2"
                >
                  <div
                    className={progress.fraction === null ? "h-full w-1/3 animate-pulse rounded bg-accent" : "h-full rounded bg-accent transition-[width]"}
                    style={progress.fraction === null ? undefined : { width: `${Math.round(progress.fraction * 100)}%` }}
                  />
                </div>
                <div className="mt-1 text-[11px] text-muted">{progress.text}</div>
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              {action && (
                <Button
                  size="sm"
                  variant={action === "uninstall" ? "danger" : "primary"}
                  disabled={action === "cancel" ? cancel.isPending : busy}
                  onClick={() => {
                    if (action === "install") void install.mutateAsync(router.id);
                    if (action === "uninstall") void uninstall.mutateAsync(router.id);
                    if (action === "cancel") void cancel.mutateAsync(router.id);
                  }}
                >
                  {primaryActionLabel(action, router)}
                </Button>
              )}
              {canRecheck(router) && (
                <Button size="sm" disabled={busy} onClick={() => void install.mutateAsync(router.id)}>
                  {isEngine(router) ? "Reinstall" : "Check for binary"}
                </Button>
              )}
              {canUninstall(router) && router.state === "failed" && (
                <Button size="sm" disabled={busy} onClick={() => void uninstall.mutateAsync(router.id)}>
                  Clear error
                </Button>
              )}
              {!isEngine(router) && (
                <Button
                  size="sm"
                  disabled={busy || !routerUsable(router) || preferredHere}
                  onClick={() => {
                    if (router.id !== "krt") void patch.mutateAsync({ preferredRouter: router.id });
                  }}
                >
                  {preferredHere ? "Default" : "Set default"}
                </Button>
              )}
            </div>
          </div>
        );
      })}
      {preferred && (
        <Button
          size="sm"
          disabled={busyBase}
          onClick={() => void patch.mutateAsync({ preferredRouter: null })}
        >
          Use automatic default (Freerouting → fab_router)
        </Button>
      )}
      <label className="block space-y-1 pt-2">
        <span className="text-xs font-medium">TraceMaker manifest URL</span>
        <span className="block text-[11px] leading-4 text-muted">
          Weekly binary index. Defaults to the public downloads host
          (<code className="font-mono">downloads.fabplane.com/tracemaker</code>). Env{" "}
          <code className="font-mono">FABDESK_TRACEMAKER_MANIFEST_URL</code> overrides this. Asset
          URLs inside the manifest must also be publicly reachable (or set{" "}
          <code className="font-mono">TRACEMAKER_BIN</code>).
        </span>
        <input
          key={settings.data?.tracemakerManifestUrl ?? "empty"}
          className="mt-1 w-full rounded-md border border-border bg-panel-2 px-2 py-1 font-mono text-[11px]"
          data-testid="tracemaker-manifest-url"
          placeholder="https://downloads.fabplane.com/tracemaker/tracemaker-latest/manifest.json"
          defaultValue={settings.data?.tracemakerManifestUrl ?? ""}
          disabled={busyBase}
          onBlur={(event) => {
            const next = event.target.value.trim() || null;
            const current = settings.data?.tracemakerManifestUrl ?? null;
            if (next !== current) void patch.mutateAsync({ tracemakerManifestUrl: next });
          }}
        />
      </label>
      <label className="block space-y-1 pt-2">
        <span className="text-xs font-medium">KiCadRoutingTools folder</span>
        <span className="block text-[11px] leading-4 text-muted">
          Use your own KiCadRoutingTools build (a folder with <code className="font-mono">src/plugins</code> and{" "}
          <code className="font-mono">venv</code>) instead of the installed copy. Empty uses env{" "}
          <code className="font-mono">FABDESK_KRT_DIR</code>, then the copy installed above.
        </span>
        <input
          key={settings.data?.krtDir ?? "empty"}
          className="mt-1 w-full rounded-md border border-border bg-panel-2 px-2 py-1 font-mono text-[11px]"
          data-testid="krt-dir"
          placeholder="(installed copy)"
          defaultValue={settings.data?.krtDir ?? ""}
          disabled={busyBase}
          onBlur={(event) => {
            const next = event.target.value.trim() || null;
            const current = settings.data?.krtDir ?? null;
            if (next !== current) void patch.mutateAsync({ krtDir: next });
          }}
        />
      </label>
    </div>
  );
}
