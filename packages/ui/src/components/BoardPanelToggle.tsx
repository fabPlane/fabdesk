import { useCore } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { modKey } from "../util";
import { Icon } from "./Icon";
import { IconButton } from "./ui";

/** The same control occupies the right-hand corner of both workspace headers. */
export function BoardPanelToggle({ location }: { location: "chat" | "board" }) {
  const { host } = useCore();
  const open = useUiStore((s) => s.boardOpen);
  const toggle = useUiStore((s) => s.toggleBoard);
  return (
    <IconButton
      size="sm"
      className="fd-board-toggle"
      data-testid={`${location}-board-toggle`}
      title={`${open ? "Hide" : "Show"} board panel (${modKey(host.platform)} + Shift + B)`}
      aria-expanded={open}
      aria-controls="board"
      onClick={() => {
        if (location === "board" && open) {
          document.querySelector<HTMLButtonElement>('[data-testid="chat-board-toggle"]')?.focus();
        }
        toggle();
      }}
    >
      <Icon name="panel" width={20} height={20} />
    </IconButton>
  );
}
