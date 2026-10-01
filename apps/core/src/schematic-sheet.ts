import { flattenHierarchy, type Schematic } from "@fp-pcb/client";
import { ToolError } from "@fabdesk/tools";

export function resolveSchematicSheet(
  hierarchy: Awaited<ReturnType<Schematic["hierarchy"]>>,
  selector?: string,
) {
  const flat = flattenHierarchy(hierarchy).map((entry) => entry.sheet);
  const matches = selector
    ? flat.filter(
        (sheet) =>
          `uuid:${sheet.path?.path.map((id) => id.value).join("/")}` === selector ||
          sheet.path?.pathHumanReadable === selector ||
          sheet.name === selector ||
          sheet.filename === selector ||
          sheet.filename.endsWith(`/${selector}`),
      )
    : flat.slice(0, 1);
  const selected = matches[0];
  if (!selected?.path)
    throw new ToolError(`sheet: schematic sheet not found: ${selector ?? "root"}`, "not_found");
  if (matches.length > 1)
    throw new ToolError(
      `sheet: ambiguous schematic sheet ${selector}; use inspected scope.identity (uuid:path)`,
      "invalid_args",
    );
  return {
    selected: selected as typeof selected & { path: NonNullable<typeof selected.path> },
    flat,
  };
}
