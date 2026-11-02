import type { MechanicalFitReport } from "@fabdesk/protocol";

export function fitIssueBoardPath(message: string, paths: string[]) {
  return (
    paths.find((path) => message.startsWith(`${path}: `) || message.startsWith(`${path} and `)) ??
    null
  );
}

export function enclosureReadiness(
  preview: boolean,
  report: MechanicalFitReport | null,
  loading: boolean,
) {
  if (report?.issues.some((i) => i.code === "verification-pending"))
    return {
      kind: "pending",
      title: "Fit checks not finished",
      detail:
        "You can inspect the shape now. Export unlocks after the checks finish; retry the preview if they fail.",
      canExport: false,
    } as const;
  if (loading)
    return {
      kind: "pending",
      title: "Checking board models",
      detail: "Wait for loading to finish before exporting.",
      canExport: false,
    } as const;
  if (!preview || !report)
    return {
      kind: "pending",
      title: "Preview needed",
      detail: "Make a preview to check the current layout and case.",
      canExport: false,
    } as const;
  const blockers = report.issues.filter((i) => i.severity === "error").length;
  if (report.status === "blocked" || blockers)
    return {
      kind: "blocked",
      title: "Cannot export yet",
      detail: blockers
        ? `Resolve ${blockers} blocking ${blockers === 1 ? "issue" : "issues"} below, then preview again.`
        : "Resolve the failed fit check, then preview again.",
      canExport: false,
    } as const;
  const notes = report.issues.filter(
    (i) => i.severity === "review" && !["coverage", "shell-coverage"].includes(i.code),
  ).length;
  return notes
    ? ({
        kind: "review",
        title: "Needs review before printing",
        detail: `${notes} ${notes === 1 ? "item needs" : "items need"} your review. Prototype export is available; physical fit is unverified.`,
        canExport: true,
      } as const)
    : ({
        kind: "ready",
        title: "Ready for prototype export",
        detail: "No known fit blockers. Check a printed sample before final use.",
        canExport: true,
      } as const);
}
