import { BOARD_MATERIAL_SUMMARIES, type BoardConstructionId, type BoardMaterialId } from "@fabdesk/protocol";
import { cn } from "../util";

export type BoardMaterialValue = {
  material: BoardMaterialId;
  construction: BoardConstructionId;
};

export function BoardMaterialPicker({
  value,
  onChange,
  compact = false,
  id = "board-material",
}: {
  value: BoardMaterialValue;
  onChange: (next: BoardMaterialValue) => void;
  compact?: boolean;
  id?: string;
}) {
  const selected = BOARD_MATERIAL_SUMMARIES.find((m) => m.id === value.material) ?? BOARD_MATERIAL_SUMMARIES[0]!;
  const constructions = selected.constructions;
  return (
    <div className="flex flex-col gap-3" data-testid="board-material-picker">
      <fieldset>
        <legend className="mb-2 text-[13px] font-medium">Board material</legend>
        <div className={cn("grid gap-2", compact ? "grid-cols-2" : "grid-cols-1 sm:grid-cols-2")}>
          {BOARD_MATERIAL_SUMMARIES.map((m) => {
            const active = m.id === value.material;
            return (
              <label
                key={m.id}
                className={cn(
                  "cursor-pointer rounded-xl border px-3 py-2.5 text-left transition-colors",
                  active ? "border-primary bg-primary/5" : "border-border bg-bg/40 hover:bg-panel-2/50",
                )}
              >
                <input
                  type="radio"
                  className="sr-only"
                  name={id}
                  value={m.id}
                  checked={active}
                  onChange={() =>
                    onChange({
                      material: m.id,
                      construction: m.defaultConstruction,
                    })
                  }
                />
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-3 w-3 shrink-0 rounded-full border border-border"
                    style={{ background: m.appearance.substrate }}
                    aria-hidden
                  />
                  <span className="text-[13px] font-medium">{m.shortName}</span>
                  {m.specialistFab && (
                    <span className="rounded-full bg-panel-2 px-1.5 text-[10px] font-medium text-muted">Specialist fab</span>
                  )}
                </div>
                {!compact && <p className="mt-1 text-[11px] leading-4 text-muted">{m.blurb}</p>}
              </label>
            );
          })}
        </div>
      </fieldset>
      {constructions.length > 1 && (
        <label className="flex flex-col gap-1 text-[13px] font-medium">
          Construction
          <select
            className="h-10 rounded-lg border border-border bg-bg px-3 text-[13px] font-normal"
            data-testid="board-construction"
            value={constructions.includes(value.construction) ? value.construction : selected.defaultConstruction}
            onChange={(e) =>
              onChange({
                material: value.material,
                construction: e.target.value as BoardConstructionId,
              })
            }
          >
            {constructions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="text-[11px] leading-4 text-muted">{selected.whenToUse}</p>
    </div>
  );
}

export function BoardMaterialBadge({
  material,
  construction,
}: {
  material?: BoardMaterialId;
  construction?: BoardConstructionId;
}) {
  const summary = BOARD_MATERIAL_SUMMARIES.find((m) => m.id === (material ?? "fr4")) ?? BOARD_MATERIAL_SUMMARIES[0]!;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-panel-2/80 px-2 py-0.5 text-[11px] font-medium"
      data-testid="board-material-badge"
      title={summary.whenToUse}
    >
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: summary.appearance.substrate }} aria-hidden />
      {summary.shortName}
      {construction ? ` · ${construction}` : ""}
    </span>
  );
}
