import type { HostAdapter } from "@fabdesk/client-core";
import { useCore } from "@fabdesk/client-core";
import type { UpdateCheckResult, UpdateDownloadState } from "@fabdesk/protocol";
import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";
import { Button } from "./ui";

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
}

export function UpdateBadge() {
  const { host } = useCore();
  return <DesktopUpdateNotice host={host} />;
}

/** Also used before the core connects. Updates belong to the desktop host and survive project changes. */
export function DesktopUpdateNotice({ host }: { host: HostAdapter }) {
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [download, setDownload] = useState<UpdateDownloadState>({ state: "idle" });
  const [actionError, setActionError] = useState("");
  const [working, setWorking] = useState(false);
  const running = useRef(false);
  const downloadEvents = useRef(0);
  const activeHost = useRef<HostAdapter | null>(null);

  useEffect(() => {
    activeHost.current = host;
    running.current = false;
    setWorking(false);
    setActionError("");
    setResult(null);
    setDownload({ state: "idle" });
    if (!host.updateStatus) return;
    let alive = true, statusEvent = false;
    const initialDownload = downloadEvents.current;
    const offStatus = host.onUpdateStatus?.(next => {
      statusEvent = true;
      if (alive) setResult(previous => next.error && previous?.updateAvailable
        ? { ...previous, checkedAt: next.checkedAt, error: next.error } : next);
    });
    const offDownload = host.onUpdateDownload?.(next => {
      downloadEvents.current++;
      if (alive) { setDownload(next); setActionError(""); }
    });
    // A previously requested snapshot can arrive after a newer push event.
    void host.updateStatus().then(next => { if (alive && !statusEvent) setResult(next); }).catch(() => {});
    void host.updateDownloadState?.().then(next => {
      if (alive && downloadEvents.current === initialDownload) setDownload(next);
    }).catch(() => {});
    return () => { alive = false; activeHost.current = null; offStatus?.(); offDownload?.(); };
  }, [host]);

  async function perform(action: () => Promise<UpdateDownloadState | void | string>) {
    if (running.current) return;
    running.current = true;
    setWorking(true);
    setActionError("");
    const start = downloadEvents.current;
    try {
      const next = await action();
      if (activeHost.current !== host) return;
      if (typeof next === "string") setActionError(next);
      else if (next && start === downloadEvents.current) setDownload(next);
    } catch (failure) {
      if (activeHost.current === host) setActionError(failure instanceof Error ? failure.message : "The update action could not finish. Try again.");
    } finally {
      if (activeHost.current === host) {
        running.current = false;
        setWorking(false);
      }
    }
  }

  const ready = download.state === "done" && download.restart === true;
  const offer = result?.updateAvailable ? result.latest : null;
  const version = download.state === "idle" ? offer?.version : download.version ?? offer?.version;
  if (!host.updateStatus || (download.state === "idle" && !offer)) return null;

  let heading = "Update available", detail = version ? `fabPlane ${version}` : "";
  let icon: IconName = "download";
  let label = "", action: (() => Promise<UpdateDownloadState | void | string>) | undefined;
  async function beginDownload() {
    if (result?.error && host.checkForUpdates) {
      const checked = await host.checkForUpdates();
      if (checked.error) throw new Error("Couldn’t reach the update service. Check your connection and retry.");
      if (!checked.updateAvailable) {
        if (activeHost.current === host) { setResult(checked); setDownload({ state: "idle" }); }
        return;
      }
    }
    return host.downloadUpdate!();
  }
  const installer = result?.installMode;
  if (download.state === "idle" && result) {
    const canDownload = Boolean(host.downloadUpdate && result.asset);
    if (!canDownload) {
      detail = `A compatible in-app package for fabPlane ${version} is unavailable.`;
      label = "View downloads";
    } else if (installer === "move-to-applications") {
      heading = "Move fabPlane to Applications";
      detail = "Run the installed copy to receive updates.";
      label = "Move to Applications";
    } else if (installer === "system-package") {
      heading = `Update to fabPlane ${version}`;
      detail = "Your system may ask you to authorize the update.";
      label = "Update with package manager";
    } else if (installer === "installer") {
      detail = "This copy requires a separate installer.";
      label = "Download installer";
    } else {
      detail = "Keep working. The new version opens on your next launch.";
      label = `Update to ${version}`;
    }
    if (result.error) detail = "Reconnect to download the update.";
    action = canDownload ? beginDownload : async () => host.openExternal(result.downloadPageUrl);
  } else if (download.state === "downloading") {
    const percent = download.percent === null ? null : Math.round(download.percent * 100);
    heading = percent === null ? "Downloading update…" : `Downloading update · ${percent}%`;
    detail = download.total ? `${mb(download.received)} of ${mb(download.total)}` : mb(download.received);
  } else if (download.state === "verifying") {
    heading = "Preparing update…";
    detail = `Verifying fabPlane ${version}.`;
  } else if (download.state === "done") {
    heading = ready ? "Ready for next launch" : "Installer downloaded";
    detail = ready ? `fabPlane ${version} will open the next time you start the app.` : download.filename;
    icon = "checkCircle";
    label = ready ? "Restart now" : "Open installer";
    action = host.openUpdate;
  } else if (download.state === "installing") {
    heading = installer === "system-package" ? "Updating with package manager…" : "Applying update…";
    detail = installer === "system-package" ? "Approve your system’s authorization prompt if it appears." : `Preparing fabPlane ${version}.`;
  } else if (download.state === "error") {
    heading = "Update couldn’t finish";
    detail = download.message;
    icon = "warning";
    label = "Retry";
    action = host.downloadUpdate && beginDownload;
  }
  return <section aria-label="FabDesk update" className="fd-update-notice" data-ready={ready || undefined}>
    <Icon name={icon} width={18} height={18} className="shrink-0 text-accent" aria-hidden />
    <div className="min-w-0 flex-1">
      <div role="status" className="flex flex-wrap items-baseline gap-x-2">
        <strong className="font-semibold">{heading}</strong>
        <span className="break-words text-muted">{detail}</span>
      </div>
      {actionError && <p role="alert" className="break-words text-danger">{actionError}</p>}
    </div>
    {download.state === "downloading" && host.cancelUpdateDownload && <Button size="sm" variant="ghost" onClick={() => {
      void host.cancelUpdateDownload!().catch(() => setActionError("Could not cancel the download. Try again."));
    }}>Cancel</Button>}
    {action && <Button size="sm" aria-label={label} variant={ready ? "secondary" : "primary"} disabled={working} onClick={() => void perform(action)}>{label}</Button>}
    {download.state === "downloading" && download.percent !== null &&
      <progress className="fd-update-progress" aria-label="Update download progress" value={download.percent} max={1} />}
  </section>;
}
