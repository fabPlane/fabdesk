import type { AssemblySchematicPreviewRevision } from "@fabdesk/protocol";
import { Button, Select } from "../components/ui";

/** Native hierarchy paths distinguish repeated sheet instances; filenames are only a legacy fallback. */
export function SchematicSheetNav({ sheets, selected, busy, onSelect }: { sheets: AssemblySchematicPreviewRevision["sheets"]; selected: string | undefined; busy: boolean; onSelect: (path: string) => void }) {
  const index = sheets.findIndex(sheet => sheet.path === selected);
  if (sheets.length < 2) return null;
  return <label className="flex min-w-0 items-center gap-2 text-xs">Sheet
    <Button size="sm" variant="secondary" aria-label="Previous schematic sheet" disabled={busy || index <= 0} onClick={() => onSelect(sheets[index - 1]!.path)}>←</Button>
    <Select aria-label="Schematic sheet" disabled={busy} value={selected ?? ""} onChange={event => onSelect(event.target.value)}>{sheets.map((sheet, i) => <option key={sheet.path} value={sheet.path}>{sheet.nativeSheet ? `${sheet.nativeSheet.pageNumber} · ${sheet.nativeSheet.hierarchyPath === "/" ? "Root circuit" : sheet.nativeSheet.hierarchyPath}` : `${i + 1} · Saved drawing · ${sheet.name.replace(/\.svg$/i, "")}`}</option>)}</Select>
    <Button size="sm" variant="secondary" aria-label="Next schematic sheet" disabled={busy || index < 0 || index >= sheets.length - 1} onClick={() => onSelect(sheets[index + 1]!.path)}>→</Button>
  </label>;
}
