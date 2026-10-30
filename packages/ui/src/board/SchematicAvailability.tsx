import type { ReactNode } from "react";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";

/** Shared availability summary, separate from file inspection and electrical rule checking. */
export function SchematicAvailability({ available, disabled, onOpen, children }: { available: boolean; disabled: boolean; onOpen: () => void; children?: ReactNode }) {
  return <section className="fd-member-checks-scope fd-member-schematic-sources" aria-label="Schematic availability">
    <div className="fd-schematic-availability-heading"><Icon name="schematic" width={22} height={22} /><div><strong>{available ? "Schematic available" : "No schematic added"}</strong><p>{available ? "Open the saved circuit for this board." : "Find it in this project, import files, or ask fabPlane to create it."}</p></div><Button size="sm" disabled={disabled} onClick={onOpen}>{available ? "Open schematic" : "Add schematic"}</Button></div>
    <p className="fd-schematic-checks-note">PCB checks review the board layout. Schematic electrical checks and comparison with the PCB are separate.</p>
    {children}
  </section>;
}
