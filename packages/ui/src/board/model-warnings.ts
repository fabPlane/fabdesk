/** File and placement information emitted by KiCad and FabDesk's model resolver. */
function declaredModel(message: string) {
  return /^(?:exact stock model unavailable|model unavailable|stock model is not available locally) \((.+)\)(?:; .+|\.)$/.exec(message)?.[1]
    ?? /^could not fetch (.+?)\. .+$/.exec(message)?.[1];
}

export function inspectModelWarnings(warnings: readonly string[]) {
  const placements = new Set<string>();
  const byFile = new Map<string, Set<string>>();
  const grouped = new Set<string>();
  for (const warning of warnings) {
    const native = /^Could not add 3D model for (.+)\.$/.exec(warning);
    if (native) {
      if (native[1] !== "(unreferenced)") placements.add(native[1]!);
      continue;
    }
    const separator = warning.indexOf(": ");
    if (separator < 1) continue;
    const message = warning.slice(separator + 2);
    const file = declaredModel(message);
    if (!file && message !== "no 3D model is assigned; add the exact part model.") continue;
    for (const ref of warning.slice(0, separator).split(", ")) {
      if (!ref || ref === "(unreferenced)") continue;
      placements.add(ref);
      if (file) {
        const refs = byFile.get(file) ?? new Set<string>();
        refs.add(ref);
        byFile.set(file, refs);
        grouped.add(ref);
      }
    }
  }
  const ungrouped = [...placements].filter(ref => !grouped.has(ref));
  const count = placements.size;
  const label = count === 1 ? "1 placement missing a 3D model" : count ? `${count} placements missing 3D models` : "Model export notes";
  return { references: [...placements], byFile, ungrouped, label };
}
