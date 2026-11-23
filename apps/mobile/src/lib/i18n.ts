import {
  APP_LOCALES,
  LOCALE_META,
  detectAppLocale,
  resolveUiLocale,
  type AppLocale,
  type UiLocaleChoice,
} from "@fabdesk/protocol";
import { catalogFor, enMessages, formatMessage, loadCatalog, type MessageKey } from "@fabdesk/ui/i18n";

export { APP_LOCALES, LOCALE_META };

export function mobileLocale(choice: UiLocaleChoice | null | undefined, languages: string[]): AppLocale {
  return resolveUiLocale(choice ?? "system", detectAppLocale({ languages }));
}

export function translate(locale: AppLocale, key: MessageKey, values?: Record<string, string | number>): string {
  const catalog = catalogFor(locale) ?? enMessages;
  return formatMessage(catalog[key] ?? enMessages[key], values, LOCALE_META[locale].bcp47);
}

export function preloadMobileCatalog(locale: AppLocale): Promise<void> {
  return loadCatalog(locale).then(() => undefined);
}
