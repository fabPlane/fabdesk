/** Keyboard order follows visible, enabled controls; a radio group is one tab stop. */
export function tabStopIndices(items: ReadonlyArray<{
  disabled: boolean;
  tabIndex: number;
  visible: boolean;
  radioGroup: string;
  checked: boolean;
}>): number[] {
  const eligible = items.map((item, index) => ({ ...item, index }))
    .filter((item) => !item.disabled && item.tabIndex >= 0 && item.visible);
  return eligible.filter((item) => {
    if (!item.radioGroup) return true;
    const group = eligible.filter((other) => other.radioGroup === item.radioGroup);
    return item === (group.find((other) => other.checked) ?? group[0]);
  }).map((item) => item.index);
}

export function tabDestination(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index - 1 + count) % count;
  return null;
}
