import type { UpdateCheckResult, UpdateDownloadState } from "@fabdesk/protocol";
import { useEffect, useState } from "react";
import { useCore } from "../core/CoreProvider";
import { cn } from "../util";

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
}

/**
 * "Update X" pill in the top bar. On Electron a click downloads the installer in-app and the
 * pill turns into a progress bar, then "Install X" opens the file. Elsewhere it opens the URL.
 */
export function UpdateBadge() {
  const { host } = useCore();
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [dl, setDl] = useState<UpdateDownloadState>({ state: "idle" });

  useEffect(() => {
    if (!host.updateStatus) return;
    let alive = true;
    host
      .updateStatus()
      .then((r) => alive && setResult(r))
      .catch(() => {});
    host
      .updateDownloadState?.()
      .then((s) => alive && setDl(s))
      .catch(() => {});
    const offStatus = host.onUpdateStatus?.((r) => alive && setResult(r));
    const offDl = host.onUpdateDownload?.((s) => alive && setDl(s));
    return () => {
      alive = false;
      offStatus?.();
      offDl?.();
    };
  }, [host]);

  if (!result?.updateAvailable || !result.latest) return null;
  const version = result.latest.version;
  const asset = result.asset;
  const canDownload = Boolean(host.downloadUpdate && asset);
  const base = "inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium leading-none";

  if (dl.state === "downloading" && dl.version === version) {
    const pct = dl.percent === null ? null : Math.round(dl.percent * 100);
    const speed = dl.bytesPerSecond ? ` · ${mb(dl.bytesPerSecond)}/s` : "";
    return (
      <button
        type="button"
        title={`Downloading ${dl.filename}: ${mb(dl.received)} of ${mb(dl.total)}${speed}. Click to cancel.`}
        onClick={() => void host.cancelUpdateDownload?.()}
        className={cn(base, "relative cursor-pointer overflow-hidden border-accent/40 bg-panel-2 text-fg")}
        aria-label={`Downloading update ${version}, ${pct ?? "?"} percent`}
      >
        <span
          className="absolute inset-y-0 left-0 bg-accent/30 transition-[width] duration-150"
          style={{ width: pct === null ? "100%" : `${pct}%` }}
          aria-hidden
        />
        <span className="relative">{pct === null ? `Downloading ${mb(dl.received)}` : `Downloading ${pct}%`}</span>
        <span className="relative text-muted">×</span>
      </button>
    );
  }
  if (dl.state === "verifying" && dl.version === version) {
    return (
      <span className={cn(base, "border-accent/40 bg-panel-2 text-fg")} title={`Verifying ${dl.filename}`}>
        Verifying…
      </span>
    );
  }
  if (dl.state === "done" && dl.version === version) {
    return (
      <button
        type="button"
        title={`${dl.filename} downloaded and verified. Click to open the installer.`}
        onClick={() => void host.openUpdate?.()}
        className={cn(base, "cursor-pointer border-success/50 bg-success/15 text-success")}
      >
        Install {version}
      </button>
    );
  }
  if (dl.state === "error" && (dl.version === undefined || dl.version === version)) {
    return (
      <button
        type="button"
        title={`${dl.message} Click to retry.`}
        onClick={() => void host.downloadUpdate?.()}
        className={cn(base, "cursor-pointer border-danger/50 bg-danger/15 text-danger")}
      >
        Update failed · retry
      </button>
    );
  }
  const size = asset ? ` (${mb(asset.size)})` : "";
  const target = asset?.url ?? result.downloadPageUrl;
  return (
    <button
      type="button"
      title={`fabPlane ${version} is available${size}. You are on ${result.currentVersion}. Click to ${canDownload ? "download" : "open the download page"}.`}
      onClick={() => (canDownload ? void host.downloadUpdate?.() : void host.openExternal(target))}
      className={cn(base, "cursor-pointer border-success/50 bg-success/15 text-success")}
    >
      Update {version}
    </button>
  );
}
