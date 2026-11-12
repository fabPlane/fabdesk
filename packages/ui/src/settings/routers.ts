import type { RouterCatalogId, RouterSnapshot } from "@fabdesk/protocol";

export type RouterAction = "install" | "uninstall" | "cancel" | "set-default";
export function routerUsable(router: RouterSnapshot): boolean { return router.ready && router.runtime?.ready !== false; }
/** Board-workflow engines (KiCadRoutingTools) install here but are never a `route_run` router or the default. */
export function isEngine(router: RouterSnapshot): boolean { return router.kind === "engine"; }

export function canInstall(router: RouterSnapshot): boolean {
  return router.install === "download" && (router.state === "not_installed" || router.state === "failed");
}

export function canUninstall(router: RouterSnapshot): boolean {
  // A router supplied by TRACEMAKER_BIN / FREEROUTING_JAR has nothing in the data dir to remove.
  return (
    router.install === "download" &&
    !router.overriddenBy &&
    (router.state === "installed" || router.state === "failed")
  );
}

/** Source-only installs can look for a published binary again without uninstalling first. */
export function canRecheck(router: RouterSnapshot): boolean {
  return (
    router.install === "download" && router.state === "installed" && !router.ready && !router.overriddenBy
  );
}

export function canCancel(router: RouterSnapshot): boolean {
  return router.state === "installing";
}

export function stateLabel(router: RouterSnapshot): string {
  if (router.ready && router.runtime?.ready === false) return `${router.state === "bundled" ? "bundled" : "installed"} · unavailable`;
  switch (router.state) {
    case "bundled":
      return router.versionInstalled && router.versionInstalled !== "bundled"
        ? `bundled ${router.versionInstalled}`
        : "bundled";
    case "installed": {
      const ver = router.versionInstalled ?? router.version;
      if (!router.ready) return isEngine(router) ? "incomplete" : "source only · not built";
      return `installed${ver && ver !== "bundled" ? ` ${ver}` : ""}${router.overriddenBy ? ` (${router.overriddenBy})` : ""}`;
    }
    case "installing": {
      const { received, total, phase } = router.progress ?? { received: 0, total: 0 };
      if (phase === "verifying") return "verifying";
      if (phase === "extracting") return "extracting";
      if (phase === "setup") return "setting up";
      if (phase === "resolving") return "installing";
      return total > 0 ? `installing ${Math.round((100 * received) / total)}%` : "installing";
    }
    case "failed":
      return "failed";
    default:
      return "not installed";
  }
}

export function primaryAction(router: RouterSnapshot): Exclude<RouterAction, "set-default"> | null {
  if (canCancel(router)) return "cancel";
  if (canInstall(router)) return "install";
  if (canUninstall(router) && router.state === "installed") return "uninstall";
  return null;
}

export function primaryActionLabel(
  action: ReturnType<typeof primaryAction>,
  router?: RouterSnapshot,
): string | null {
  if (action === "install") return router?.state === "failed" ? "Retry" : "Install";
  if (action === "uninstall") return "Uninstall";
  if (action === "cancel") return "Cancel";
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export type InstallProgressView = {
  /** 0..1 while the total is known, null for an indeterminate phase. */
  fraction: number | null;
  /** "Downloading 3.2 / 20.0 MB", "Verifying checksum…", "Extracting…" */
  text: string;
};

/** What the card's progress bar shows while an install job runs; null when nothing is installing. */
export function installProgressView(router: RouterSnapshot): InstallProgressView | null {
  if (router.state !== "installing") return null;
  const { received, total, phase } = router.progress ?? { received: 0, total: 0 };
  if (phase === "resolving") return { fraction: null, text: "Looking for a published binary…" };
  if (phase === "verifying") return { fraction: 1, text: "Verifying checksum…" };
  if (phase === "extracting") return { fraction: 1, text: "Extracting…" };
  if (phase === "setup") return { fraction: null, text: "Setting up Python (venv, numpy, scipy, shapely)…" };
  if (total > 0)
    return {
      fraction: Math.min(1, received / total),
      text: `Downloading ${formatBytes(received)} / ${formatBytes(total)}`,
    };
  return { fraction: null, text: `Downloading ${formatBytes(received)}` };
}

/**
 * The Settings dialog saves its draft with one PATCH. The router default is written the moment "Set
 * default" is clicked, so it is left out of the draft: a stale copy in the draft must never revert it
 * on Save, nor make the dialog look dirty.
 */
export function withoutRouterDefault<T extends { preferredRouter?: unknown; tracemakerManifestUrl?: unknown; krtDir?: unknown }>(
  settings: T,
): Omit<T, "preferredRouter" | "tracemakerManifestUrl" | "krtDir"> {
  const { preferredRouter: _preferred, tracemakerManifestUrl: _manifest, krtDir: _krt, ...rest } = settings;
  return rest;
}

export type RouterPickerOption = {
  id: "default" | RouterCatalogId;
  label: string;
  disabled: boolean;
  hint: string;
  /** Why an option is disabled, shown next to its label ("not installed", "not built", ...). */
  note?: string;
};

function notReadyNote(router: RouterSnapshot): string {
  if (router.ready && router.runtime?.ready === false) return "engine unavailable";
  if (router.state === "installing") return "installing";
  if (router.state === "failed") return "install failed";
  if (router.state === "installed") return "not built";
  return "not installed";
}

/** Cinema / route-trigger picker. `default` keeps today's Freerouting → fab_router path. */
export function routerPickerOptions(
  routers: RouterSnapshot[],
  preferred?: RouterCatalogId,
): RouterPickerOption[] {
  const preferredName = routers.find((r) => r.id === preferred)?.displayName ?? preferred;
  const preferredUnusable = !!preferred && routers.some((r) => r.id === preferred && !routerUsable(r));
  const automaticReady = !!preferred && routers.some(router => router.id === preferred && routerUsable(router)) || routers.some(router => (router.id === "freerouting" || router.id === "fab_router") && routerUsable(router));
  const options: RouterPickerOption[] = [
    {
      id: "default",
      label: preferred
        ? `Default (${preferredName}${preferredUnusable ? " not ready → Freerouting → fab_router" : ""})`
        : "Default (Freerouting → fab_router)",
      disabled: !automaticReady,
      hint: automaticReady ? "Leave unset so routing keeps the current automatic default." : "No automatic router is available. Check the PCB backend and router settings.",
    },
  ];
  for (const router of routers) {
    if (isEngine(router)) continue;
    options.push({
      id: router.id,
      label: router.displayName,
      disabled: !routerUsable(router),
      hint: router.runtime?.ready === false ? router.runtime.reason ?? router.installHint : router.ready ? router.strengths[0] ?? router.description : router.installHint,
      ...(routerUsable(router) ? {} : { note: notReadyNote(router) }),
    });
  }
  return options;
}

export function isPreferred(router: RouterSnapshot, preferred?: RouterCatalogId): boolean {
  return preferred === router.id;
}
