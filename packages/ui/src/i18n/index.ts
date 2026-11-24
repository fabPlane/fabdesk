export { APP_LOCALES, LOCALE_META, PSEUDO_LOCALE, detectAppLocale, matchAppLocale, resolveUiLocale } from "@fabdesk/protocol";
export type { AppLocale, LoadableLocale, UiLocaleChoice, AgentReplyChoice } from "@fabdesk/protocol";
export { messages as enMessages, type MessageKey, type MessageCatalog } from "./catalogs/en";
export { formatMessage, formatDate, formatNumber } from "./format";
export { GLOSSARY, GLOSSARY_TERMS, glossaryTerm, glossaryCoverage } from "./glossary";
export type { GlossaryTermId } from "./glossary";
export { toPseudoCatalog, toPseudoString } from "./pseudo";
export { loadCatalog, catalogFor, fallbackCatalog } from "./load";
export { I18nProvider, useI18n, useT, detectHostLocale, hostLocales } from "./I18nProvider";
export type { I18nApi } from "./I18nProvider";
export {
  applyCommentTranslation,
  buildTranslateCommentPrompt,
  translationKeepsOriginal,
} from "./translate-comment";
export type { CommentTranslation } from "./translate-comment";
