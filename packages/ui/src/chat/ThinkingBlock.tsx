import { useState } from "react";
import { cn } from "../util";

export function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const preview = text.trim().split("\n")[0]?.slice(0, 120) ?? "";
  return (
    <div className="my-1.5 rounded-lg border border-border/70 bg-panel-2/50 text-xs">
      <button
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-fg hover:bg-panel-2/70"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={cn("inline-block shrink-0 transition-transform", open && "rotate-90")}>&#9656;</span>
        <span className={cn("shrink-0 whitespace-nowrap font-medium", streaming && "fd-activity-shimmer")}>{streaming ? "Thinking..." : "Thought"}</span>
        {!open && <span className="min-w-0 truncate italic opacity-70">{preview}</span>}
      </button>
      {open && <pre className="whitespace-pre-wrap px-3 pb-2.5 font-sans text-muted">{text}</pre>}
    </div>
  );
}
