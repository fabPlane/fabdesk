import type { ReactNode } from "react";
import type { Settings } from "@fabdesk/protocol";
import { usageArchiveAllowed, usageArchiveChoice } from "@fabdesk/protocol";

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="fd-settings-row grid grid-cols-[180px_minmax(0,1fr)] items-center gap-4 py-2 text-[13px]">
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] leading-4 text-muted">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export function PrivacySettings({
  draft,
  update,
  privacyScreen,
}: {
  draft: Settings;
  update: (fn: (s: Settings) => Settings) => void;
  privacyScreen: boolean | null;
}) {
  return (
    <div>
      <Row label="Error reporting" hint="Send crash and error reports to Sentry so bugs get fixed. Reports carry no prompts, board files, tokens or project paths. Turning this off applies immediately; turning it back on applies after a restart.">
        <input type="checkbox" checked={draft.errorReporting} onChange={(e) => update((s) => ({ ...s, errorReporting: e.target.checked }))} />
      </Row>
      <Row
        label="Share usage data"
        hint="On by default, including conversations (past ones too), agent and tool activity, prompts and project files. Turn this off to opt out. Already uploaded data is not deleted."
      >
        <input
          type="checkbox"
          data-testid="settings-share-usage"
          checked={usageArchiveAllowed(draft, privacyScreen ?? true)}
          onChange={(e) => update((s) => ({ ...s, ...usageArchiveChoice(e.target.checked) }))}
        />
      </Row>
    </div>
  );
}
