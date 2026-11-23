import {
  detectAppLocale,
  localeBcp47,
  resolveUiLocale,
  type AppLocale,
  type LoadableLocale,
  type UiLocaleChoice,
} from "@fabdesk/protocol";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { messages as en, type MessageKey } from "./catalogs/en";
import { formatDate, formatMessage, formatNumber, type FormatValues } from "./format";
import { glossaryTerm, type GlossaryTermId } from "./glossary";
import { catalogFor, fallbackCatalog, loadCatalog, resolveLoadableLocale } from "./load";

export function hostLocales(): string[] {
  if (typeof navigator !== "undefined") {
    const list = navigator.languages?.length ? [...navigator.languages] : [navigator.language];
    return list.filter((item): item is string => !!item);
  }
  const env = [
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
    process.env.LANGUAGE,
  ].filter((item): item is string => !!item);
  return env;
}

export function detectHostLocale(): AppLocale {
  return detectAppLocale({ languages: hostLocales() });
}

export interface I18nApi {
  locale: LoadableLocale;
  bcp47: string;
  t: (key: MessageKey, values?: FormatValues) => string;
  term: (id: GlossaryTermId) => string;
  formatDate: (value: Date | string, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  ready: boolean;
}

const I18nContext = createContext<I18nApi | null>(null);

export function I18nProvider({
  choice,
  override,
  onResolved,
  children,
}: {
  choice?: UiLocaleChoice | null;
  /** Test hook (pseudo-locale, story screens). */
  override?: LoadableLocale | null;
  onResolved?: (locale: AppLocale) => void;
  children: ReactNode;
}) {
  const detected = useMemo(() => detectHostLocale(), []);
  const resolved = override
    ? resolveLoadableLocale(override)
    : resolveUiLocale(choice ?? "system", detected);
  const [catalog, setCatalog] = useState(() => catalogFor(resolved) ?? fallbackCatalog());
  const [ready, setReady] = useState(() => resolved === "en" || !!catalogFor(resolved));

  useEffect(() => {
    let cancelled = false;
    const cached = catalogFor(resolved);
    if (cached) {
      setCatalog(cached);
      setReady(true);
    } else {
      setReady(false);
      void loadCatalog(resolved).then((loaded) => {
        if (cancelled) return;
        setCatalog(loaded);
        setReady(true);
      });
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = localeBcp47(resolved);
      document.documentElement.dataset.locale = resolved;
    }
    if (!override && resolved !== "qps") onResolved?.(resolved);
    return () => {
      cancelled = true;
    };
  }, [resolved, override, onResolved]);

  const api = useMemo<I18nApi>(() => {
    const bcp47 = localeBcp47(resolved);
    const appLocale: AppLocale = resolved === "qps" ? "en" : resolved;
    return {
      locale: resolved,
      bcp47,
      ready,
      t: (key, values) => {
        const template = catalog[key] ?? en[key] ?? key;
        return formatMessage(template, values, bcp47);
      },
      term: (id) => glossaryTerm(appLocale, id),
      formatDate: (value, options) => formatDate(bcp47, value, options),
      formatNumber: (value, options) => formatNumber(bcp47, value, options),
    };
  }, [catalog, ready, resolved]);

  return <I18nContext.Provider value={api}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nApi {
  const ctx = useContext(I18nContext);
  if (ctx) return ctx;
  return englishOnly;
}

const englishOnly: I18nApi = {
  locale: "en",
  bcp47: "en",
  ready: true,
  t: (key, values) => formatMessage(en[key] ?? key, values, "en"),
  term: (id) => glossaryTerm("en", id),
  formatDate: (value, options) => formatDate("en", value, options),
  formatNumber: (value, options) => formatNumber("en", value, options),
};

export function useT(): I18nApi["t"] {
  return useI18n().t;
}
