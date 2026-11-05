import type { BoardComment } from "@fabdesk/protocol";
import { commentAnchorLabel } from "@fabdesk/protocol";
import { cn } from "../util";
import { commentPointForDrawing, svgPointToPercent, type SvgBox, type SvgPoint } from "./svg-coords";

export function CommentPins({
  comments,
  box,
  selectedId,
  onSelect,
  draftPoint = null,
  nativePcbCoordinates = false,
}: {
  comments: BoardComment[];
  box: SvgBox | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  draftPoint?: SvgPoint | null;
  nativePcbCoordinates?: boolean;
}) {
  if (!box) return null;
  const draftPosition = draftPoint ? svgPointToPercent(box, draftPoint) : null;
  return (
    <div className="pointer-events-none absolute inset-0" data-testid="comment-pins">
      {draftPosition && (
        <div role="img" aria-label="New pin location" data-testid="comment-draft-location"
          className="absolute -translate-x-1/2 -translate-y-1/2 text-blue-600"
          style={{ left: `${draftPosition.left}%`, top: `${draftPosition.top}%` }}>
          <svg width="44" height="44" viewBox="0 0 44 44" fill="none" aria-hidden="true">
            <circle cx="22" cy="22" r="20" fill="currentColor" fillOpacity=".15" />
            <circle cx="22" cy="22" r="12" stroke="white" strokeWidth="5" />
            <circle cx="22" cy="22" r="12" stroke="currentColor" strokeWidth="2" />
            <path d="M22 3v9m0 20v9M3 22h9m20 0h9" stroke="currentColor" strokeWidth="2" />
            <circle cx="22" cy="22" r="3" fill="currentColor" stroke="white" strokeWidth="1" />
          </svg>
          <span className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-blue-600 px-2 py-1 text-[11px] font-semibold text-white shadow-sm">New pin</span>
        </div>
      )}
      {comments.map((comment, index) => {
        const point = commentPointForDrawing(comment.anchor, nativePcbCoordinates);
        if (!point) return null;
        const pos = svgPointToPercent(box, point);
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
                ? "border-primary bg-primary text-primary-fg ring-4 ring-accent/30 ring-offset-2 ring-offset-panel"
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
