import { useState } from "react";
import { usePatchSettings } from "@fabdesk/client-core";
import { usageArchiveChoice } from "@fabdesk/protocol";
import { Button } from "../components/ui";
import { useI18n } from "../i18n";

/**
 * Asked only where the core requires consent first (see `PrivacyStatus`). The box starts
 * unchecked because a pre-ticked box is not valid consent under the GDPR; nothing is shared until
 * Continue saves the choice.
 */
export function FirstInstallPrivacy() {
  const { t } = useI18n();
  const [shareUsage, setShareUsage] = useState(false);
  const patch = usePatchSettings();

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-bg p-6" style={{ alignItems: "safe center" }}>
      <div className="w-full max-w-md rounded-2xl border border-border bg-panel p-6 shadow-xl">
        <h1 className="text-lg font-semibold">{t("privacy.title")}</h1>
        <p className="mt-3 text-sm text-muted">
          {t("privacy.body")}
        </p>
        <label className="mt-5 flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={shareUsage}
            onChange={(event) => setShareUsage(event.target.checked)}
            className="mt-1"
          />
          <span>{t("privacy.share")}</span>
        </label>
        <p className="mt-3 text-xs text-muted">
          {t("privacy.canChange")}
        </p>
        {patch.isError && <p className="mt-3 text-xs text-danger">{t("privacy.saveError")}</p>}
        <Button
          variant="primary"
          className="mt-5 w-full"
          disabled={patch.isPending}
          onClick={() => patch.mutate(usageArchiveChoice(shareUsage))}
        >
          {patch.isPending ? t("privacy.saving") : t("privacy.continue")}
        </Button>
      </div>
    </div>
  );
}
