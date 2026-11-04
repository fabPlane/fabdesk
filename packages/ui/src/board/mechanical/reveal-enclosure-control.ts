import type { EnclosureIssueTarget } from "@fabdesk/client-core";

/** Open every containing disclosure, then put keyboard focus at the relevant controls. */
export function revealEnclosureControl(
  root: HTMLElement | null,
  name: EnclosureIssueTarget,
  boardPath?: string | null,
) {
  const matches = [
    ...(root?.querySelectorAll<HTMLElement>(`[data-enclosure-control="${name}"]`) ?? []),
  ];
  const target =
    matches.find((element) => boardPath && element.dataset.boardPath === boardPath) ?? matches[0];
  if (!target) return;
  for (
    let element: HTMLElement | null = target;
    element && element !== root;
    element = element.parentElement
  ) {
    if (element.tagName === "DETAILS") (element as HTMLDetailsElement).open = true;
  }
  target.scrollIntoView({ block: "nearest" });
  const control = target.querySelector<HTMLElement>(
    "summary, input:not(:disabled), select:not(:disabled), button:not(:disabled)",
  );
  control?.focus({ preventScroll: true });
}
