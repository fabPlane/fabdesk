import { IconButton, Tabs } from "../components/ui";
import { useCore } from "../core/CoreProvider";
import { BOARD_TABS, BOARD_TAB_LABELS, useUiStore, type BoardTab } from "../stores/ui";
import { modKey } from "../util";
import { CinemaTab } from "./cinema/CinemaTab";
import { DrcTab } from "./DrcTab";
import { FilesTab } from "./FilesTab";
import { RendersTab } from "./RendersTab";
import { SvgTab } from "./SvgTab";
import { ThreeDTab } from "./ThreeDTab";

function TabBody({ tab }: { tab: BoardTab }) {
  switch (tab) {
    case "schematic":
      return <SvgTab kind="schematic" />;
    case "pcb":
      return <SvgTab kind="pcb" />;
    case "cinema":
      return <CinemaTab />;
    case "3d":
      return <ThreeDTab />;
    case "drc":
      return <DrcTab />;
    case "renders":
      return <RendersTab />;
    case "files":
      return <FilesTab />;
    default:
      return null;
  }
}

export function BoardPanel() {
  const { host } = useCore();
  const tab = useUiStore((s) => s.boardTab);
  const setBoardTab = useUiStore((s) => s.setBoardTab);
  const setBoardOpen = useUiStore((s) => s.setBoardOpen);
  const mod = modKey(host.platform);
  return (
    <div className="flex h-full min-w-0 flex-col bg-panel">
      <div className="flex h-10 items-center gap-1 border-b border-border px-2">
        <Tabs
          className="min-w-0 flex-1"
          tabs={BOARD_TABS.map((id, i) => ({ id, label: BOARD_TAB_LABELS[id], hint: `${mod}${i + 1}` }))}
          value={tab}
          onChange={setBoardTab}
        />
        <IconButton title={`Hide board panel (${mod}Shift+B)`} onClick={() => setBoardOpen(false)}>
          &#10005;
        </IconButton>
      </div>
      <div className="min-h-0 flex-1">
        <TabBody tab={tab} />
      </div>
    </div>
  );
}
