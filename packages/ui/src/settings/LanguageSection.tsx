import { LOCALE_META, APP_LOCALES, type Settings } from "@fabdesk/protocol";
import { Select } from "../components/ui";
import { useI18n } from "../i18n";

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
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

export function LanguageSection({
  draft,
  update,
}: {
  draft: Settings;
  update: (fn: (s: Settings) => Settings) => void;
}) {
  const { t, locale } = useI18n();
  return (
    <div className="space-y-3" data-testid="settings-language">
      <Row label={t("settings.language.ui")} hint={t("settings.language.uiHint")}>
        <Select
          value={draft.uiLocale}
          onChange={(e) => {
            const uiLocale = e.target.value as Settings["uiLocale"];
            const speech = LOCALE_META[uiLocale === "system" ? "en" : uiLocale]?.bcp47 ?? draft.voice.language;
            update((s) => ({
              ...s,
              uiLocale,
              voice: {
                ...s.voice,
                language: uiLocale === "system" ? s.voice.language : speech,
              },
            }));
          }}
          data-testid="settings-ui-locale"
        >
          <option value="system">{t("settings.language.system")}</option>
          {APP_LOCALES.map((id) => (
            <option key={id} value={id}>
              {LOCALE_META[id].nativeName} — {LOCALE_META[id].nameEn}
            </option>
          ))}
        </Select>
      </Row>
      <Row label={t("settings.language.agent")} hint={t("settings.language.agentHint")}>
        <Select
          value={draft.agentReplyLanguage}
          onChange={(e) => update((s) => ({ ...s, agentReplyLanguage: e.target.value as Settings["agentReplyLanguage"] }))}
          data-testid="settings-agent-reply-language"
        >
          <option value="match">{t("settings.language.matchMessage")}</option>
          {APP_LOCALES.map((id) => (
            <option key={id} value={id}>
              {LOCALE_META[id].nativeName} — {LOCALE_META[id].nameEn}
            </option>
          ))}
        </Select>
      </Row>
      <p className="text-[12px] leading-5 text-muted">{t("settings.language.designNote")}</p>
      {locale !== "en" && <p className="text-[11px] text-muted">{t("settings.language.needsReview")}</p>}
    </div>
  );
}
