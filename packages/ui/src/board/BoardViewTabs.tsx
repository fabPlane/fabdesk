import { Tabs } from "../components/ui";

/** The same named views in both single-board and assembly workspaces. */
export function BoardViewTabs({ value, disabled = false, onChange }: {
  value: string;
  disabled?: boolean;
  onChange: (value: "pcb" | "schematic" | "system" | "3d" | "layers") => void;
}) {
  return <div className="fd-board-view-tabs" inert={disabled || undefined}>
    <Tabs tabs={[
      { id: "pcb" as const, label: "2D", icon: "pcb" as const },
      { id: "system" as const, label: "System", icon: "system" as const },
      { id: "3d" as const, label: "3D", icon: "cube" as const },
      { id: "layers" as const, label: "Layers", icon: "pcb" as const },
      { id: "schematic" as const, label: "Schematic", icon: "schematic" as const },
    ]} value={value} onChange={next => { if (next === "pcb" || next === "schematic" || next === "system" || next === "3d" || next === "layers") onChange(next); }} />
  </div>;
}
