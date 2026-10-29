import { Tabs } from "../components/ui";

/** The same named views in both single-board and assembly workspaces. */
export function BoardViewTabs({ value, disabled = false, onChange }: {
  value: string;
  disabled?: boolean;
  onChange: (value: "pcb" | "schematic" | "3d") => void;
}) {
  return <div className="fd-board-view-tabs" inert={disabled || undefined}>
    <Tabs tabs={[
      { id: "pcb" as const, label: "PCB", icon: "pcb" as const },
      { id: "schematic" as const, label: "Schematic", icon: "schematic" as const },
      { id: "3d" as const, label: "3D", icon: "cube" as const },
    ]} value={value} onChange={next => { if (next === "pcb" || next === "schematic" || next === "3d") onChange(next); }} />
  </div>;
}
