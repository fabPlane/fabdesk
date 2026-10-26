import { Button } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { formatVoiceShortcut, parseVoiceShortcut, type VoiceState } from "@fabdesk/client-core";
import { cn } from "../../util";

export function VoiceBar({
  state,
  shortcut,
  platform,
  onCancel,
  onOpenSettings,
}: {
  state: VoiceState;
  shortcut: string;
  platform?: string;
  onCancel: () => void;
  onOpenSettings: () => void;
}) {
  const keys = formatVoiceShortcut(parseVoiceShortcut(shortcut), platform);
  if (state.phase === "idle" && !state.error) return null;
  if (state.phase === "sent" || state.phase === "cancelled") return null;

  return (
    <div
      className={cn(
        "fd-voice-bar mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
        state.errorKind === "permission_denied" || state.errorKind === "unavailable" || state.errorKind === "transcribe_failed"
          ? "border-warning/30 bg-warning/5 text-warning"
          : "border-border bg-panel-2 text-fg",
      )}
      data-testid="voice-bar"
      role="status"
    >
      {state.phase === "recording" && (
        <>
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger/60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-danger" />
          </span>
          <LevelMeter level={state.level} />
          <span className="min-w-0 flex-1 truncate font-medium">
            {state.partial.trim() || "Listening…"}
          </span>
          <span className="shrink-0 text-muted">Esc cancels · {keys}</span>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </>
      )}
      {state.phase === "transcribing" && (
        <>
          <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-accent" />
          <span className="min-w-0 flex-1 truncate">Transcribing…</span>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </>
      )}
      {state.phase === "editing" && (
        <>
          <Icon name="mic" width={14} height={14} />
          <span className="min-w-0 flex-1 truncate text-muted">Edit the transcript, then send.</span>
        </>
      )}
      {state.phase === "idle" && state.error && (
        <>
          <span className="min-w-0 flex-1 leading-4">{state.error}</span>
          <Button size="sm" variant="ghost" onClick={onOpenSettings}>
            Voice settings
          </Button>
        </>
      )}
    </div>
  );
}

export function LevelMeter({ level }: { level: number }) {
  const bars = 6;
  const filled = Math.round(level * bars);
  return (
    <span className="flex h-3 items-end gap-px" aria-hidden="true" data-testid="voice-level">
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className={cn("w-[3px] rounded-sm", i < filled ? "bg-accent" : "bg-border")}
          style={{ height: `${6 + i * 2}px` }}
        />
      ))}
    </span>
  );
}

export function MicButton({
  active,
  disabled,
  title,
  mode,
  onHoldStart,
  onHoldEnd,
  onToggle,
}: {
  active: boolean;
  disabled?: boolean;
  title: string;
  mode: "hold" | "toggle";
  onHoldStart: () => void;
  onHoldEnd: () => void;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border-0 text-muted transition-colors hover:bg-panel-2/70 hover:text-fg disabled:pointer-events-none disabled:opacity-45",
        active && "bg-danger/10 text-danger hover:bg-danger/15 hover:text-danger",
      )}
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      data-testid="voice-mic"
      onClick={mode === "toggle" ? onToggle : undefined}
      onPointerDown={
        mode === "hold"
          ? (e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId);
              onHoldStart();
            }
          : undefined
      }
      onPointerUp={mode === "hold" ? onHoldEnd : undefined}
      onPointerCancel={mode === "hold" ? onHoldEnd : undefined}
    >
      <Icon name="mic" width={16} height={16} />
    </button>
  );
}
