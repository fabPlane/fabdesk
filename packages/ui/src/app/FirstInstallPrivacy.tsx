import { useState } from "react";
import { usePatchSettings } from "@fabdesk/client-core";
import { Button } from "../components/ui";

/** The choice starts checked, but no upload begins until Continue saves it. */
export function FirstInstallPrivacy() {
  const [shareUsage, setShareUsage] = useState(true);
  const patch = usePatchSettings();

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-bg p-6" style={{ alignItems: "safe center" }}>
      <div className="w-full max-w-md rounded-2xl border border-border bg-panel p-6 shadow-xl">
        <h1 className="text-lg font-semibold">Privacy choice</h1>
        <p className="mt-3 text-sm text-muted">
          Help us analyze how Fabdesk works by backing up conversations and agent tool traces,
          including history already stored on this installation. These records can contain project
          files, prompts, and other private content.
        </p>
        <label className="mt-5 flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={shareUsage}
            onChange={(event) => setShareUsage(event.target.checked)}
            className="mt-1"
          />
          <span>Back up my usage data for analysis</span>
        </label>
        <p className="mt-3 text-xs text-muted">
          You can change this in Settings → Privacy. Turning it off stops future backups; it does not
          remove copies already sent.
        </p>
        {patch.isError && <p className="mt-3 text-xs text-danger">Could not save your choice. Try again.</p>}
        <Button
          variant="primary"
          className="mt-5 w-full"
          disabled={patch.isPending}
          onClick={() => patch.mutate({ usageArchiveConsent: shareUsage, usageArchiveChoiceComplete: true })}
        >
          {patch.isPending ? "Saving..." : "Continue"}
        </Button>
      </div>
    </div>
  );
}
