import { useCore } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { modKey } from "../util";
import { Icon } from "./Icon";
import { IconButton } from "./ui";

/** One persistent control stays in the workspace corner while its panes slide. */
export function BoardPanelToggle() {
  const { host } = useCore();
  const open = useUiStore((s) => s.boardOpen);
  const toggle = useUiStore((s) => s.toggleBoard);
  return (
    <IconButton
      size="sm"
      className="fd-board-toggle"
      data-testid="workspace-board-toggle"
      title={`${open ? "Hide" : "Show"} board panel (${modKey(host.platform)} + Shift + B)`}
      aria-expanded={open}
      aria-controls="board"
      onClick={toggle}
    >
      <Icon name="panel" width={20} height={20} />
    </IconButton>
  );
}
