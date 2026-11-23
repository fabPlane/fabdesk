/**
 * Reply-language policy for the in-app agent: detect the language of each user
 * message, expose a per-thread hint, and keep design identifiers untouched.
 */
import {
  APP_LOCALES,
  LOCALE_META,
  isAgentReplyChoice,
  isAppLocale,
  type AppLocale,
} from "@fabdesk/protocol";

export const LANGUAGE_RULE = [
  "## Language",
  "Reply in the language of the latest user message, or the language named in the Reply-language hint if one is present.",
  "Never translate part numbers, net names, pin names, reference designators, units, file paths, or generated KiCad/CAD content. Those stay exactly as written in every language.",
  "Tool-call arguments keep identifiers and file contents byte-for-byte; do not localize net, footprint, pad, via, or pin names inside tools.",
  "A teammate's note or comment in another language may be explained in the user's language, with links to the nets and parts it refers to. Keep the original wording available.",
  "",
].join("\n");

export const REPLY_LANGUAGE_HINT_PREFIX = "[Reply-language:";

const CJK_HAN = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const HIRAGANA = /[\u3040-\u309F]/;
const KATAKANA = /[\u30A0-\u30FF]/;
const HANGUL = /[\uAC00-\uD7AF\u1100-\u11FF]/;
const THAI = /[\u0E00-\u0E7F]/;
const DEVANAGARI = /[\u0900-\u097F]/;

const LATIN_HINTS: { locale: AppLocale; words: readonly string[] }[] = [
  { locale: "de", words: ["und", "nicht", "bitte", "können", "über", "zwischen", "schaltung", "prüfen"] },
  { locale: "fr", words: ["les", "une", "pas", "pour", "avec", "cette", "schéma", "merci"] },
  { locale: "es", words: ["los", "las", "una", "por", "para", "este", "esquema", "gracias"] },
  { locale: "pt-BR", words: ["não", "uma", "para", "com", "este", "essa", "obrigado", "esquemático"] },
  { locale: "it", words: ["non", "una", "per", "con", "questo", "grazie", "schema"] },
  { locale: "pl", words: ["nie", "się", "jest", "oraz", "proszę", "schemat"] },
  { locale: "tr", words: ["bir", "değil", "için", "lütfen", "kontrol"] },
  { locale: "vi", words: ["không", "của", "và", "trong", "kiểm"] },
  { locale: "id", words: ["yang", "dan", "tidak", "untuk", "dengan", "silakan"] },
  { locale: "en", words: ["the", "and", "please", "this", "with", "from", "check", "board"] },
];

export function detectMessageLanguage(text: string): AppLocale {
  const sample = text.normalize("NFC");
  if (THAI.test(sample)) return "th";
  if (DEVANAGARI.test(sample)) return "hi";
  if (HANGUL.test(sample)) return "ko";
  if (HIRAGANA.test(sample) || KATAKANA.test(sample)) return "ja";
  if (CJK_HAN.test(sample)) return detectChinese(sample);
  return detectLatin(sample);
}

function detectChinese(sample: string): AppLocale {
  if (/[爾麼東車門萬與對業發經]/.test(sample)) return "zh-Hant";
  return "zh-Hans";
}

function detectLatin(sample: string): AppLocale {
  const tokens = sample
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  if (tokens.length === 0) return "en";
  const counts = new Map<AppLocale, number>();
  for (const { locale, words } of LATIN_HINTS) {
    let score = 0;
    for (const word of words) if (tokens.includes(word)) score += 1;
    if (score > 0) counts.set(locale, score);
  }
  let best: AppLocale = "en";
  let bestScore = 0;
  for (const [locale, score] of counts) {
    if (score > bestScore) {
      best = locale;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : "en";
}

export function resolveReplyLanguage(input: {
  preference?: string | null;
  message: string;
  threadHint?: AppLocale | null;
}): { locale: AppLocale; source: "setting" | "message" | "thread" } {
  const preference = input.preference && isAgentReplyChoice(input.preference) ? input.preference : "match";
  if (preference !== "match" && isAppLocale(preference)) {
    return { locale: preference, source: "setting" };
  }
  const detected = detectMessageLanguage(input.message);
  if (detected !== "en" || !looksLikeIdentifierSoup(input.message)) {
    return { locale: detected, source: "message" };
  }
  if (input.threadHint && isAppLocale(input.threadHint)) {
    return { locale: input.threadHint, source: "thread" };
  }
  return { locale: detected, source: "message" };
}

function looksLikeIdentifierSoup(text: string): boolean {
  const letters = text.replace(/[^A-Za-z\u00C0-\u024F]/g, "");
  return letters.length < 8;
}

export function languageHintBlock(locale: AppLocale): string {
  const meta = LOCALE_META[locale];
  return REPLY_LANGUAGE_HINT_PREFIX + " " + meta.nameEn + " (" + locale + ")]";
}

export function applyReplyLanguage(
  prompt: string,
  locale: AppLocale,
): { prompt: string; hint: string } {
  const hint = languageHintBlock(locale);
  if (prompt.startsWith(REPLY_LANGUAGE_HINT_PREFIX)) return { prompt, hint };
  return { prompt: hint + "\n\n" + prompt, hint };
}

export const DESIGN_IDENTIFIER =
  /(?:USB_D[+-]|\b(?:SPI\.[A-Z]+|I2C_[A-Z]+|[A-Z]{1,3}\d{1,4}[A-Z]?|[A-Z][A-Z0-9]*_[A-Z0-9_]+|GND|VCC|VDD|VSS|VBUS)\b)/g;

export function extractDesignIdentifiers(text: string): string[] {
  return [...new Set(text.match(DESIGN_IDENTIFIER) ?? [])];
}

export function identifiersUntouched(original: string, output: string): string[] {
  return extractDesignIdentifiers(original).filter((id) => !output.includes(id));
}

export function assertToolArgsPreserveIdentifiers(
  message: string,
  args: Record<string, unknown>,
): string[] {
  const serialized = JSON.stringify(args);
  return extractDesignIdentifiers(message).filter((id) => message.includes(id) && !serialized.includes(id));
}

export function localeLabel(locale: AppLocale): string {
  return LOCALE_META[locale]?.nameEn ?? locale;
}

export const AGENT_REPLY_LOCALES = APP_LOCALES;
