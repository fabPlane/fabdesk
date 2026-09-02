import type { UpdateCheckResult } from "@fabdesk/protocol";
import { useEffect, useState } from "react";
import { useCore } from "../core/CoreProvider";
import { Badge } from "./ui";

/** Shows "Update vX available" when the host's update checker found a newer release; click opens the download. */
export function UpdateBadge() {
  const { host } = useCore();
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  useEffect(() => {
    if (!host.updateStatus) return;
    let alive = true;
    host
      .updateStatus()
      .then((r) => {
        if (alive) setResult(r);
      })
      .catch(() => {});
    const off = host.onUpdateStatus?.((r) => {
      if (alive) setResult(r);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [host]);
  if (!result?.updateAvailable || !result.latest) return null;
  const target = result.asset?.url ?? result.downloadPageUrl;
  const size = result.asset ? ` (${Math.round(result.asset.size / 1048576)} MB)` : "";
  return (
    <button
      type="button"
      title={`Fabdesk ${result.latest.version} is available${size}. You are on ${result.currentVersion}. Click to download.`}
      onClick={() => void host.openExternal(target)}
      className="cursor-pointer"
    >
      <Badge tone="success">Update {result.latest.version}</Badge>
    </button>
  );
}
