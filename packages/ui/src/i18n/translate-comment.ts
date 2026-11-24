import type { AppLocale, BoardComment } from "@fabdesk/protocol";
import { commentAnchorLabel, LOCALE_META } from "@fabdesk/protocol";

const DESIGN_IDENTIFIER =
  /(?:USB_D[+-]|\b(?:SPI\.[A-Z]+|I2C_[A-Z]+|[A-Z]{1,3}\d{1,4}[A-Z]?|[A-Z][A-Z0-9]*_[A-Z0-9_]+|GND|VCC|VDD|VSS|VBUS)\b)/g;

function extractDesignIdentifiers(text: string): string[] {
  return [...new Set(text.match(DESIGN_IDENTIFIER) ?? [])];
}

export interface CommentTranslation {
  original: string;
  translated: string;
  locale: AppLocale;
  identifiers: string[];
}

/** The original text is always kept; translation is a sibling, never a replacement. */
export function applyCommentTranslation(
  original: string,
  translated: string,
  locale: AppLocale,
): CommentTranslation {
  return {
    original,
    translated,
    locale,
    identifiers: extractDesignIdentifiers(original),
  };
}

export function buildTranslateCommentPrompt(
  comment: Pick<BoardComment, "question" | "anchor" | "answer">,
  locale: AppLocale,
): string {
  const meta = LOCALE_META[locale];
  const identifiers = extractDesignIdentifiers(`${comment.question}\n${comment.answer ?? ""}`);
  const keep = identifiers.length ? identifiers.join(", ") : "(none found)";
  return [
    `Translate the board comment below into ${meta.nameEn} (${locale}).`,
    "Keep the original meaning. Do not replace the original — the UI shows both.",
    "Leave part numbers, net names, pin names, reference designators and units exactly as written.",
    `Identifiers that must stay verbatim: ${keep}`,
    `Anchor: ${commentAnchorLabel(comment.anchor)}`,
    "",
    `Original: ${comment.question}`,
    ...(comment.answer ? [`Agent answer: ${comment.answer}`] : []),
    "",
    "If the comment names a net or part, mention that same identifier in the translation so the reader can jump to it.",
  ].join("\n");
}

export function translationKeepsOriginal(value: CommentTranslation): boolean {
  return value.original.length > 0 && value.identifiers.every((id) => value.original.includes(id));
}
