import { useState } from "react";
import { Button } from "../components/ui";
import { useI18n } from "./I18nProvider";
import { applyCommentTranslation, type CommentTranslation } from "./translate-comment";

/**
 * Keeps the author's original text on screen and optionally shows a translation under it.
 * The original is never replaced.
 */
export function TranslateText({
  original,
  translation,
  onRequest,
  hideOriginal = false,
  className,
}: {
  original: string;
  translation?: CommentTranslation | null;
  onRequest?: () => Promise<CommentTranslation | null> | CommentTranslation | null;
  /** When the original is already on screen (notes editor, review card). */
  hideOriginal?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [local, setLocal] = useState<CommentTranslation | null>(null);
  const shown = local ?? translation ?? null;

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    if (shown) {
      setOpen(true);
      return;
    }
    if (!onRequest) {
      setOpen(true);
      return;
    }
    setPending(true);
    try {
      const result = await onRequest();
      if (result) setLocal(applyCommentTranslation(result.original || original, result.translated, result.locale));
      setOpen(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={className} data-testid="translate-text">
      {!hideOriginal && <div data-testid="translate-original">{original}</div>}
      <div className="mt-1 flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => void toggle()} disabled={pending} data-testid="translate-toggle">
          {pending ? t("board.translating") : open ? t("board.hideTranslation") : t("board.translate")}
        </Button>
      </div>
      {open && shown && (
        <div className="mt-1 rounded-md border border-border bg-panel-2/60 px-2 py-1.5 text-[12.5px]" data-testid="translate-result">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">{t("review.translationByAgent")}</div>
          <div>{shown.translated}</div>
        </div>
      )}
      {open && !shown && (
        <p className="mt-1 text-[11px] text-muted">{t("review.translationByAgent")}</p>
      )}
    </div>
  );
}
