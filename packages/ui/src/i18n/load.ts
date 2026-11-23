import { isAppLocale, PSEUDO_LOCALE, type AppLocale, type LoadableLocale } from "@fabdesk/protocol";
import { messages as en, type MessageCatalog } from "./catalogs/en";
import { toPseudoCatalog } from "./pseudo";

const cache = new Map<LoadableLocale, MessageCatalog>();
cache.set("en", en);

export function catalogFor(locale: LoadableLocale): MessageCatalog | undefined {
  return cache.get(locale);
}

export async function loadCatalog(locale: LoadableLocale): Promise<MessageCatalog> {
  const hit = cache.get(locale);
  if (hit) return hit;
  if (locale === PSEUDO_LOCALE) {
    const catalog = toPseudoCatalog(en);
    cache.set(PSEUDO_LOCALE, catalog);
    return catalog;
  }
  const loaded = await importTranslated(locale);
  cache.set(locale, loaded);
  return loaded;
}

async function importTranslated(locale: AppLocale): Promise<MessageCatalog> {
  switch (locale) {
    case "zh-Hans":
      return (await import("./catalogs/zh-Hans")).messages;
    case "zh-Hant":
      return (await import("./catalogs/zh-Hant")).messages;
    case "ja":
      return (await import("./catalogs/ja")).messages;
    case "ko":
      return (await import("./catalogs/ko")).messages;
    case "th":
      return (await import("./catalogs/th")).messages;
    case "de":
      return (await import("./catalogs/de")).messages;
    case "fr":
      return (await import("./catalogs/fr")).messages;
    case "es":
      return (await import("./catalogs/es")).messages;
    case "pt-BR":
      return (await import("./catalogs/pt-BR")).messages;
    case "it":
      return (await import("./catalogs/it")).messages;
    case "pl":
      return (await import("./catalogs/pl")).messages;
    case "tr":
      return (await import("./catalogs/tr")).messages;
    case "vi":
      return (await import("./catalogs/vi")).messages;
    case "id":
      return (await import("./catalogs/id")).messages;
    case "hi":
      return (await import("./catalogs/hi")).messages;
    default:
      return en;
  }
}

export function fallbackCatalog(): MessageCatalog {
  return en;
}

export function resolveLoadableLocale(value: string | null | undefined): LoadableLocale {
  if (value === PSEUDO_LOCALE) return PSEUDO_LOCALE;
  return isAppLocale(value) ? value : "en";
}
