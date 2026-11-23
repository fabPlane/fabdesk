import type { PhotoSide, PhotoSighting, SightedItem, SightedKind } from "@fabdesk/protocol";
import { Input, Select } from "../components/ui";

const KINDS: SightedKind[] = [
  "ic",
  "connector",
  "switch",
  "led",
  "battery",
  "display",
  "encoder",
  "passive",
  "mounting_hole",
  "other",
];
const SIDES: PhotoSide[] = ["front", "back", "unknown"];

export function WhatISeeTable({
  sighting,
  onChange,
}: {
  sighting: PhotoSighting;
  onChange: (next: PhotoSighting) => void;
}) {
  const update = (id: string, patch: Partial<SightedItem>) => {
    onChange({
      ...sighting,
      items: sighting.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    });
  };
  return (
    <div className="overflow-x-auto" data-testid="what-i-see">
      <table className="w-full min-w-[640px] border-collapse text-left text-xs">
        <thead>
          <tr className="text-muted">
            <th className="px-2 py-1 font-medium">Kind</th>
            <th className="px-2 py-1 font-medium">Label</th>
            <th className="px-2 py-1 font-medium">Markings</th>
            <th className="px-2 py-1 font-medium">MPN</th>
            <th className="px-2 py-1 font-medium">Side</th>
            <th className="px-2 py-1 font-medium">Confidence</th>
          </tr>
        </thead>
        <tbody>
          {sighting.items.map((item) => (
            <tr key={item.id} className="border-t border-border">
              <td className="px-2 py-1">
                <Select
                  aria-label={`Kind for ${item.label}`}
                  value={item.kind}
                  onChange={(e) => update(item.id, { kind: e.target.value as SightedKind })}
                >
                  {KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </Select>
              </td>
              <td className="px-2 py-1">
                <Input
                  aria-label={`Label for ${item.id}`}
                  value={item.label}
                  onChange={(e) => update(item.id, { label: e.target.value })}
                />
              </td>
              <td className="px-2 py-1">
                <Input
                  aria-label={`Markings for ${item.label}`}
                  value={item.markings ?? ""}
                  onChange={(e) =>
                    update(item.id, { ...(e.target.value ? { markings: e.target.value } : {}) })
                  }
                />
              </td>
              <td className="px-2 py-1">
                <Input
                  aria-label={`MPN for ${item.label}`}
                  value={item.mpn ?? ""}
                  onChange={(e) =>
                    update(item.id, { ...(e.target.value ? { mpn: e.target.value } : {}) })
                  }
                />
              </td>
              <td className="px-2 py-1">
                <Select
                  aria-label={`Side for ${item.label}`}
                  value={item.side}
                  onChange={(e) => update(item.id, { side: e.target.value as PhotoSide })}
                >
                  {SIDES.map((side) => (
                    <option key={side} value={side}>
                      {side}
                    </option>
                  ))}
                </Select>
              </td>
              <td className="px-2 py-1">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel-2">
                    <div
                      className="h-full bg-accent"
                      style={{ width: `${Math.round(item.confidence * 100)}%` }}
                    />
                  </div>
                  <span className="w-8 text-right text-muted">{Math.round(item.confidence * 100)}%</span>
                </div>
              </td>
            </tr>
          ))}
          {sighting.items.length === 0 && (
            <tr>
              <td colSpan={6} className="px-2 py-3 text-muted">
                No parts listed yet. Add items after the vision pass, or type what you see.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
