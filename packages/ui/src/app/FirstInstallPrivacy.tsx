import { useState } from "react";
import { usePatchSettings } from "@fabdesk/client-core";
import { usageArchiveChoice } from "@fabdesk/protocol";
import { Button } from "../components/ui";

/**
 * One-time notice for everyone (`FIRST_INSTALL_PRIVACY_SCREEN` is `always` unless overridden).
 * Sharing is on unless the person unchecks the box; Continue saves that choice.
 */
export function FirstInstallPrivacy() {
  const [shareUsage, setShareUsage] = useState(true);
  const patch = usePatchSettings();

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-bg p-6" style={{ alignItems: "safe center" }}>
      <div className="w-full max-w-md rounded-2xl border border-border bg-panel p-6 shadow-xl">
        <h1 className="text-lg font-semibold">Usage data is on unless you opt out</h1>
        <p className="mt-3 text-sm text-muted">
          We'll upload usage data from this installation unless you uncheck the box. This includes:
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
          <li>Conversations, including past ones</li>
          <li>Agent and tool activity</li>
          <li>Prompts and project files</li>
        </ul>
        <label className="mt-5 flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={shareUsage}
            onChange={(event) => setShareUsage(event.target.checked)}
            className="mt-1"
          />
          <span>Share usage data (uncheck to opt out)</span>
        </label>
        <p className="mt-3 text-xs text-muted">
          You can turn this off anytime in Settings → Privacy. Turning it off stops future sharing; it
          doesn't remove what was already shared.
        </p>
        {patch.isError && <p className="mt-3 text-xs text-danger">Could not save your choice. Try again.</p>}
        <Button
          variant="primary"
          className="mt-5 w-full"
          disabled={patch.isPending}
          onClick={() => patch.mutate(usageArchiveChoice(shareUsage))}
        >
          {patch.isPending ? "Saving..." : "Continue"}
        </Button>
      </div>
    </div>
  );
}
