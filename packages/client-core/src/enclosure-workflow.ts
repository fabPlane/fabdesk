/** Selection order is cosmetic; adding/removing a board requires confirmation again. */
export function enclosureSelectionKey(paths: string[]) {
  return JSON.stringify([...new Set(paths)].sort());
}

export function enclosureWorkflow({
  paths,
  readyPaths,
  confirmedSelection,
  hasPreview,
  recovering = false,
}: {
  paths: string[];
  readyPaths: string[];
  confirmedSelection: string | null;
  hasPreview: boolean;
  recovering?: boolean;
}) {
  const ready = new Set(readyPaths);
  const reason = recovering
    ? "Resolve the saved draft first."
    : !paths.length
      ? "Choose at least one board to continue."
      : paths.some((p) => !ready.has(p))
        ? "Reading the selected boards…"
        : null;
  const canContinue = reason === null;
  const boardsComplete = canContinue && confirmedSelection === enclosureSelectionKey(paths);
  return {
    canContinue,
    boardsComplete,
    caseUnlocked: boardsComplete,
    previewUnlocked: boardsComplete && hasPreview,
    boardsHint: reason ?? "Your boards are ready. Use automatic setup or choose your case options.",
    caseHint: boardsComplete ? null : (reason ?? "Confirm your boards to unlock case setup."),
    previewHint: boardsComplete
      ? "Create a case preview to unlock this step."
      : "Complete Boards and Case first.",
  };
}
