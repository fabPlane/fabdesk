import { useState } from "react";
import { usePatchSettings } from "@fabdesk/client-core";
import { productAnalyticsChoice, usageArchiveChoice } from "@fabdesk/protocol";
import { Button } from "../components/ui";

/** Analytics asks on every undecided device, independently of region or website consent. */
export function FirstInstallPrivacy({ askUsageArchive = false }: { askUsageArchive?: boolean }) {
  const patch = usePatchSettings();
  return <PrivacyChoicesForm askUsageArchive={askUsageArchive} pending={patch.isPending}
    failed={patch.isError} onSave={(analytics, usage) => patch.mutate({
      ...productAnalyticsChoice(analytics),
      ...(askUsageArchive ? usageArchiveChoice(usage) : {}),
    })} />;
}

/** Shared by the live screen and its isolated UI preview. */
export function PrivacyChoicesForm({ askUsageArchive, pending, failed, onSave }: {
  askUsageArchive: boolean;
  pending: boolean;
  failed: boolean;
  onSave: (analytics: boolean, usage: boolean) => void;
}) {
  const [shareAnalytics, setShareAnalytics] = useState(false);
  const [shareUsage, setShareUsage] = useState(false);

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-bg p-6" style={{ alignItems: "safe center" }}>
      <div className="w-full max-w-lg rounded-2xl border border-border bg-panel p-6 shadow-xl">
        <h1 className="text-lg font-semibold">Your privacy choices</h1>
        <p className="mt-3 text-sm text-muted">Product analytics is off until you choose. You can use fabPlane without enabling it.</p>
        <label className="mt-5 flex items-start gap-3 text-sm">
          <input type="checkbox" checked={shareAnalytics} onChange={(event) => setShareAnalytics(event.target.checked)} className="mt-1" />
          <span>Share product analytics with PostHog</span>
        </label>
        <p className="mt-2 text-xs text-muted">
          App activation, successful board builds and limited error categories help us understand where
          people get stuck. If present, campaign tags connect your website visit to app use. Signing in
          links this activity to your account ID. Analytics contains no prompts, board files, tokens,
          emails, project names, paths or error text.
        </p>
        {askUsageArchive && <>
          <label className="mt-5 flex items-start gap-3 text-sm">
            <input type="checkbox" checked={shareUsage} onChange={(event) => setShareUsage(event.target.checked)} className="mt-1" />
            <span>Share sessions and project data with fabPlane</span>
          </label>
          <p className="mt-2 text-xs text-muted">
            This separate choice shares conversations and agent activity, including past sessions,
            and can include prompts and project files. We keep it private.
          </p>
        </>}
        <p className="mt-4 text-xs text-muted">
          Change these choices anytime in Settings → Privacy. Turning sharing off stops future
          sharing; it does not remove data already sent. Crash reporting has its own setting there.
        </p>
        {failed && <p role="alert" className="mt-3 text-xs text-danger">Could not save your choices. Try again.</p>}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button disabled={pending} onClick={() => onSave(false, false)}>{askUsageArchive ? "Continue without sharing" : "Continue without analytics"}</Button>
          <Button variant="primary" disabled={pending} onClick={() => onSave(shareAnalytics, shareUsage)}>
            {pending ? "Saving..." : "Save choices and continue"}
          </Button>
        </div>
      </div>
    </div>
  );
}
