import { useState } from "react";
import { usePatchSettings } from "@fabdesk/client-core";
import { usageArchiveChoice } from "@fabdesk/protocol";
import { Button } from "../components/ui";

/**
 * Asked only where the core requires consent first (see `PrivacyStatus`). The box starts
 * unchecked because a pre-ticked box is not valid consent under the GDPR; nothing is shared until
 * Continue saves the choice.
 */
export function FirstInstallPrivacy() {
  const [shareUsage, setShareUsage] = useState(false);
  const patch = usePatchSettings();

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-bg p-6" style={{ alignItems: "safe center" }}>
      <div className="w-full max-w-md rounded-2xl border border-border bg-panel p-6 shadow-xl">
        <h1 className="text-lg font-semibold">Help improve Fabdesk</h1>
        <p className="mt-3 text-sm text-muted">
          Share your sessions with us so we can see where Fabdesk gets stuck and make it better. This
          includes your conversations and agent activity, past ones too, and can include your prompts
          and project files. We keep it private.
        </p>
        <label className="mt-5 flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={shareUsage}
            onChange={(event) => setShareUsage(event.target.checked)}
            className="mt-1"
          />
          <span>Share usage data to help improve Fabdesk</span>
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
