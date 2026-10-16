import { ToolError } from "@fabdesk/tools";

type Metadata = { reference: string; value: string; footprint: string };

export function assertEditableSymbolField(name: string): void {
  if (["Reference", "Value", "Footprint"].includes(name))
    throw new ToolError(
      `symbolUpdates.fields: use newReference, value or footprint to change ${name}`,
      "invalid_args",
    );
}

/** Validate the projected hierarchy before sending any shared metadata changes to KiCad. */
export function assertConsistentSymbolMetadata(
  symbols: readonly Metadata[],
  references: Iterable<string>,
): void {
  for (const reference of new Set(references)) {
    const units = symbols.filter((symbol) => symbol.reference === reference);
    if (new Set(units.map((symbol) => JSON.stringify([symbol.value, symbol.footprint]))).size > 1)
      throw new ToolError(
        `symbolUpdates: all placed units of ${reference} must have the same value and footprint; include every affected unit in the batch, or replace the inspected units together`,
        "invalid_args",
      );
  }
}
