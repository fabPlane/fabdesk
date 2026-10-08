import type { BoardComment } from "@fabdesk/protocol";
import { commentAnchorLabel } from "@fabdesk/protocol";
import { cn } from "../util";
import { svgPointToPercent, type SvgBox } from "./svg-coords";

export function CommentPins({
  comments,
  box,
  selectedId,
  onSelect,
}: {
  comments: BoardComment[];
  box: SvgBox | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (!box) return null;
  return (
    <div className="pointer-events-none absolute inset-0" data-testid="comment-pins">
      {comments.map((comment, index) => {
        if (comment.anchor.x === undefined || comment.anchor.y === undefined) return null;
        const pos = svgPointToPercent(box, { x: comment.anchor.x, y: comment.anchor.y });
        if (!pos) return null;
        const selected = comment.id === selectedId;
        return (
          <button
            key={comment.id}
            type="button"
            data-comment-pin={comment.id}
            data-testid={`comment-pin-${comment.id}`}
            title={`${index + 1} · ${commentAnchorLabel(comment.anchor)} · ${comment.question}`}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(comment.id);
            }}
            className={cn(
              "pointer-events-auto absolute flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border text-[10px] font-semibold shadow-sm",
              selected
                ? "border-primary bg-primary text-primary-fg"
                : comment.status === "resolved"
                  ? "border-border bg-panel-2 text-muted"
                  : comment.status === "answered"
                    ? "border-accent bg-accent/20 text-fg"
                    : "border-primary/60 bg-primary text-primary-fg",
            )}
            style={{ left: `${pos.left}%`, top: `${pos.top}%` }}
          >
            {index + 1}
          </button>
        );
      })}
    </div>
  );
}
