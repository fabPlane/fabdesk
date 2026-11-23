/** UI and agent-reply locales shipped in the first version. English is the source language. */
export const APP_LOCALES = [
  "en",
  "zh-Hans",
  "zh-Hant",
  "ja",
  "ko",
  "th",
  "de",
  "fr",
  "es",
  "pt-BR",
  "it",
  "pl",
  "tr",
  "vi",
  "id",
  "hi",
] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

/** Test-only expanded locale used to catch layout overflow. Not offered as a normal preference. */
export const PSEUDO_LOCALE = "qps" as const;
export type PseudoLocale = typeof PSEUDO_LOCALE;
export type LoadableLocale = AppLocale | PseudoLocale;

export const UI_LOCALE_CHOICES = ["system", ...APP_LOCALES] as const;
export type UiLocaleChoice = (typeof UI_LOCALE_CHOICES)[number];

export const AGENT_REPLY_CHOICES = ["match", ...APP_LOCALES] as const;
export type AgentReplyChoice = (typeof AGENT_REPLY_CHOICES)[number];

export interface LocaleMeta {
  id: AppLocale;
  /** BCP-47 tag for Intl and speech recognition. */
  bcp47: string;
  /** English name, used in Settings lists next to the native name. */
  nameEn: string;
  /** Endonym shown in the language picker. */
  nativeName: string;
}

export const LOCALE_META: Record<AppLocale, LocaleMeta> = {
  en: { id: "en", bcp47: "en", nameEn: "English", nativeName: "English" },
  "zh-Hans": { id: "zh-Hans", bcp47: "zh-CN", nameEn: "Simplified Chinese", nativeName: "简体中文" },
  "zh-Hant": { id: "zh-Hant", bcp47: "zh-TW", nameEn: "Traditional Chinese", nativeName: "繁體中文" },
  ja: { id: "ja", bcp47: "ja-JP", nameEn: "Japanese", nativeName: "日本語" },
  ko: { id: "ko", bcp47: "ko-KR", nameEn: "Korean", nativeName: "한국어" },
  th: { id: "th", bcp47: "th-TH", nameEn: "Thai", nativeName: "ไทย" },
  de: { id: "de", bcp47: "de-DE", nameEn: "German", nativeName: "Deutsch" },
  fr: { id: "fr", bcp47: "fr-FR", nameEn: "French", nativeName: "Français" },
  es: { id: "es", bcp47: "es-ES", nameEn: "Spanish", nativeName: "Español" },
  "pt-BR": { id: "pt-BR", bcp47: "pt-BR", nameEn: "Brazilian Portuguese", nativeName: "Português (Brasil)" },
  it: { id: "it", bcp47: "it-IT", nameEn: "Italian", nativeName: "Italiano" },
  pl: { id: "pl", bcp47: "pl-PL", nameEn: "Polish", nativeName: "Polski" },
  tr: { id: "tr", bcp47: "tr-TR", nameEn: "Turkish", nativeName: "Türkçe" },
  vi: { id: "vi", bcp47: "vi-VN", nameEn: "Vietnamese", nativeName: "Tiếng Việt" },
  id: { id: "id", bcp47: "id-ID", nameEn: "Indonesian", nativeName: "Bahasa Indonesia" },
  hi: { id: "hi", bcp47: "hi-IN", nameEn: "Hindi", nativeName: "हिन्दी" },
};

export function isAppLocale(value: string | null | undefined): value is AppLocale {
  return !!value && (APP_LOCALES as readonly string[]).includes(value);
}

export function isUiLocaleChoice(value: string | null | undefined): value is UiLocaleChoice {
  return !!value && (UI_LOCALE_CHOICES as readonly string[]).includes(value);
}

export function isAgentReplyChoice(value: string | null | undefined): value is AgentReplyChoice {
  return !!value && (AGENT_REPLY_CHOICES as readonly string[]).includes(value);
}

export function localeBcp47(locale: LoadableLocale): string {
  if (locale === PSEUDO_LOCALE) return "en";
  return LOCALE_META[locale].bcp47;
}

/**
 * Map a BCP-47 / POSIX locale from the OS or browser onto a shipped UI locale.
 * Script and region beat language-only tags (`zh-TW` → Traditional, `pt-BR` → Brazilian).
 */
export function matchAppLocale(tag: string | null | undefined): AppLocale | null {
  if (!tag) return null;
  const normalized = tag.trim().split(/[.@]/)[0]!.replace(/_/g, "-");
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  if (lower === "zh-hans" || lower.startsWith("zh-hans-")) return "zh-Hans";
  if (lower === "zh-hant" || lower.startsWith("zh-hant-")) return "zh-Hant";
  if (lower === "pt-br" || lower.startsWith("pt-br-")) return "pt-BR";
  const parts = lower.split("-");
  const lang = parts[0] ?? "";
  const region = (parts[parts.length - 1] ?? "").toUpperCase();
  if (lang === "zh") {
    if (["TW", "HK", "MO"].includes(region)) return "zh-Hant";
    return "zh-Hans";
  }
  if (lang === "pt") return region === "PT" ? "pt-BR" : "pt-BR";
  const byLang: Record<string, AppLocale> = {
    en: "en",
    ja: "ja",
    ko: "ko",
    th: "th",
    de: "de",
    fr: "fr",
    es: "es",
    it: "it",
    pl: "pl",
    tr: "tr",
    vi: "vi",
    id: "id",
    hi: "hi",
  };
  return byLang[lang] ?? null;
}

/** First matching shipped locale from `navigator.languages` / `Intl` / env, else English. */
export function detectAppLocale(input: {
  languages?: readonly (string | null | undefined)[] | undefined;
}): AppLocale {
  for (const tag of input.languages ?? []) {
    const matched = matchAppLocale(tag);
    if (matched) return matched;
  }
  return "en";
}

export function resolveUiLocale(choice: UiLocaleChoice | null | undefined, detected: AppLocale): AppLocale {
  if (choice && choice !== "system" && isAppLocale(choice)) return choice;
  return detected;
}
