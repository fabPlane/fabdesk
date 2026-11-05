import { useEffect, useId, useState, type ReactNode } from "react";
import type { MechanicalFitIssue, MechanicalFitReport } from "@fabdesk/protocol";
import {
  enclosureFileLabel,
  fitIssueBoardPath,
  enclosureReviewGroups,
  enclosureIssueSummary,
} from "@fabdesk/client-core";
import { Icon } from "../../components/Icon";

type Destination = "Start" | "Space" | "PCB";
const guidance: Record<string, { title: string; destination: Destination; action: string }> = {
  "case-size-limit": {
    title: "The whole case is too large for your print area",
    destination: "Start",
    action: "Review size limit",
  },
  "opening-web": {
    title: "Thin wall beside a port",
    destination: "Start",
    action: "Review port openings",
  },
  "cable-route-blocked": {
    title: "A cable needs a clear path",
    destination: "Start",
    action: "Review cable space and board positions",
  },
  "screw-tool-access": {
    title: "A screw is hard to reach",
    destination: "PCB",
    action: "Review board position",
  },
  "assembly-obstruction": {
    title: "A part needs a different assembly path",
    destination: "PCB",
    action: "Review board position",
  },
  "assembly-sampled": {
    title: "Straight-down assembly sampled",
    destination: "Start",
    action: "Review assembly checks",
  },
  "assembly-unavailable": {
    title: "Assembly check is incomplete",
    destination: "Start",
    action: "Review model checks",
  },
  "fit-allowance": {
    title: "Room for small sizing differences",
    destination: "Start",
    action: "Review fit allowance",
  },
  "holder-tolerance": {
    title: "Choose holders with fit allowance",
    destination: "Start",
    action: "Choose edge holders",
  },
  "holder-space": {
    title: "The board needs a different restraint",
    destination: "Start",
    action: "Review board holders",
  },
  "detailed-layers": {
    title: "Flat board layers excluded",
    destination: "PCB",
    action: "Review board surfaces",
  },
  "detailed-clearance": {
    title: "3D parts are too close",
    destination: "PCB",
    action: "Leave more space",
  },
  "detailed-collision": {
    title: "3D parts intersect",
    destination: "PCB",
    action: "Rearrange the boards",
  },
  "detailed-missing": {
    title: "Some 3D models are missing",
    destination: "PCB",
    action: "Inspect PCB models",
  },
  "detailed-open": {
    title: "A model needs repair",
    destination: "PCB",
    action: "Inspect PCB models",
  },
  "detailed-unavailable": {
    title: "Detailed check is incomplete",
    destination: "PCB",
    action: "Review model coverage",
  },
  "holder-collision": {
    title: "A holder touches a component",
    destination: "Start",
    action: "Review board holders",
  },
  "holder-room": {
    title: "The holder needs more room",
    destination: "Start",
    action: "Review board holders",
  },
  "holder-outline": {
    title: "This board needs custom retention",
    destination: "Start",
    action: "Review board holders",
  },
  "holder-closure": {
    title: "Secure the holder with a screwed lid",
    destination: "Start",
    action: "Choose lid screws",
  },
  "hardware-access": {
    title: "Hardware blocks a port",
    destination: "Start",
    action: "Review lid and holders",
  },
  "closure-length": {
    title: "Lid screw length needs changing",
    destination: "Start",
    action: "Review lid screws",
  },
  "closure-size": {
    title: "Lid screw dimensions do not fit",
    destination: "Start",
    action: "Review lid screws",
  },
  "native-clearance": {
    title: "Detailed model needs more room",
    destination: "PCB",
    action: "Rearrange or enlarge the case",
  },
  "cable-endpoint": {
    title: "Reconnect the cable endpoints",
    destination: "PCB",
    action: "Review connections",
  },
  "cable-length": {
    title: "Cable cannot reach",
    destination: "PCB",
    action: "Adjust layout or cable",
  },
  "cable-routing": {
    title: "Check the cable bend path",
    destination: "PCB",
    action: "Review cable allowance",
  },
  "port-wall": {
    title: "Port faces the wrong wall",
    destination: "PCB",
    action: "Review port direction",
  },
  "port-measurements": {
    title: "Confirm the connector and plug",
    destination: "PCB",
    action: "Set port dimensions",
  },
  "plug-reach": {
    title: "Plug cannot reach through the wall",
    destination: "PCB",
    action: "Check mating reach",
  },
  "plug-collision": {
    title: "Plug access is obstructed",
    destination: "PCB",
    action: "Separate ports or obstacles",
  },
  "mount-support": {
    title: "Post does not support the PCB",
    destination: "Space",
    action: "Align screw posts",
  },
  "mount-bearing": {
    title: "Not enough support around the hole",
    destination: "Space",
    action: "Widen the post",
  },
  "mount-wall": {
    title: "Screw post wall is too thin",
    destination: "Space",
    action: "Adjust screw posts",
  },
  "mount-overlap": {
    title: "Screw posts overlap",
    destination: "Space",
    action: "Review screw posts",
  },
  "screw-head-unknown": {
    title: "Add your screw dimensions",
    destination: "Space",
    action: "Set screw dimensions",
  },
  "screw-head-clearance": {
    title: "Screw head needs more room",
    destination: "Space",
    action: "Review screw clearance",
  },
  "screw-head-size": {
    title: "Screw head is smaller than the hole",
    destination: "Space",
    action: "Check screw dimensions",
  },
  "mount-none": {
    title: "Choose how to secure the board",
    destination: "Space",
    action: "Review PCB holes",
  },
  "screw-shaft": {
    title: "Screw is wider than the PCB hole",
    destination: "Space",
    action: "Check screw dimensions",
  },
  "screw-length": {
    title: "Screw length does not fit the post",
    destination: "Space",
    action: "Adjust screw or post height",
  },
  "screw-engagement": {
    title: "Screw cannot grip the post",
    destination: "Space",
    action: "Check the post hole and screw size",
  },
  "shell-surface": {
    title: "Possible case interference",
    destination: "PCB",
    action: "Adjust board position",
  },
  "shell-clearance": {
    title: "Too close to the case surface",
    destination: "PCB",
    action: "Adjust board position",
  },
  dimensions: {
    title: "Confirm your dimensions",
    destination: "Start",
    action: "Check dimensions",
  },
  "no-board": { title: "Add a board to check fit", destination: "PCB", action: "Add a board" },
  "outside-space": {
    title: "More room is needed",
    destination: "Space",
    action: "Move board or resize case",
  },
  obstacle: { title: "Parts are too close", destination: "Space", action: "Review obstacles" },
  "board-geometry": {
    title: "Board outline needs review",
    destination: "PCB",
    action: "Inspect PCB",
  },
  "mount-hole": {
    title: "Mounting hole is missing",
    destination: "PCB",
    action: "Review PCB holes",
  },
  "mount-height": {
    title: "Mounting post is too tall",
    destination: "Space",
    action: "Adjust mounting posts",
  },
  "mount-collision": {
    title: "Mounting post is too close to a part",
    destination: "Space",
    action: "Adjust mounting posts",
  },
  "connector-opening": {
    title: "Check connector access",
    destination: "Space",
    action: "Review openings",
  },
  "board-collision": {
    title: "Boards are too close",
    destination: "PCB",
    action: "Adjust board positions",
  },
  "opening-bounds": {
    title: "Opening extends past the wall",
    destination: "Space",
    action: "Adjust openings",
  },
  "mount-bounds": {
    title: "Mounting post is outside the case",
    destination: "Space",
    action: "Adjust mounting posts",
  },
};

/** Keep the first view to a problem name and one action; details remain available on demand. */
export function FitProblem({
  title,
  blocked = false,
  focused = false,
  count = 1,
  expanded,
  onExpandedChange,
  onReveal,
  children,
}: {
  title: string;
  blocked?: boolean;
  focused?: boolean;
  count?: number;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  onReveal?: () => void;
  children: ReactNode;
}) {
  const [localOpen, setLocalOpen] = useState(focused);
  const open = expanded ?? localOpen;
  const contentId = useId();
  useEffect(() => {
    if (focused) setLocalOpen(true);
  }, [focused]);
  return (
    <article
      className={`fd-fit-problem${blocked ? " is-blocker" : ""}${focused ? " is-focused" : ""}`}
      aria-label={blocked ? `${title} — required fix` : title}
    >
      <div className="fd-fit-problem-heading">
        <h3>{title}</h3>
        {count > 1 && (
          <span className="fd-fit-problem-count" aria-label={`${count} findings`}>
            {count}
          </span>
        )}
      </div>
      <button
        type="button"
        className="fd-fit-solution-toggle"
        aria-expanded={open}
        aria-controls={contentId}
        aria-label={`${open ? "Hide" : "Show"} solution: ${title}`}
        onClick={() => {
          setLocalOpen(!open);
          onExpandedChange?.(!open);
          if (!open) onReveal?.();
        }}
      >
        {open ? "Hide solution" : "Show solution"}
      </button>
      <div className="fd-fit-solution" id={contentId} hidden={!open}>
        {blocked && <p className="fd-fit-required">Fix this before exporting.</p>}
        {children}
      </div>
    </article>
  );
}

export function fitProblemTitle(issue: MechanicalFitIssue) {
  return (
    guidance[issue.code]?.title ??
    (issue.code.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase()) || "Fit needs review")
  );
}

/** Presentation groups keep repeated findings together without changing any fit results. */
export function fitProblemGroups(issues: MechanicalFitIssue[]) {
  const methodIssues =
    enclosureReviewGroups(issues).find((group) => group.id === "method")?.issues ?? [];
  const methodSet = new Set(methodIssues);
  const grouped = new Map<string, MechanicalFitIssue[]>();
  for (const issue of issues) {
    if (methodSet.has(issue)) continue;
    const key = `${issue.severity}:${issue.code}`;
    const group = grouped.get(key) ?? [];
    group.push(issue);
    grouped.set(key, group);
  }
  const problems = [...grouped]
    .map(([key, findings]) => ({ key, issues: findings }))
    .sort(
      (a, b) =>
        Number(b.issues[0]!.severity === "error") - Number(a.issues[0]!.severity === "error"),
    );
  return { problems, methodIssues };
}

/** Match the number of problem cards, rather than the number of repeated findings. */
export function fitProblemCount(report: MechanicalFitReport) {
  if (report.issues.some((issue) => issue.code === "verification-pending")) return 0;
  const extraBlocker =
    report.status === "blocked" && !report.issues.some((issue) => issue.severity === "error");
  return fitProblemGroups(report.issues).problems.length + 1 + Number(extraBlocker);
}

/** One problem and one finding at a time; every original fix remains reachable. */
export function EnclosureFitReview({
  report,
  onNavigate,
  onShowIssue,
  onClearIssue,
  partPicker,
  focusedIssue,
  readiness,
  canShowIssue = (issue) => !!issue.regions?.length,
}: {
  report: MechanicalFitReport;
  onNavigate: (step: Destination, code: string, issue: MechanicalFitIssue) => void;
  onShowIssue: (issue: MechanicalFitIssue) => void;
  onClearIssue?: () => void;
  partPicker?: ReactNode;
  focusedIssue: MechanicalFitIssue | null;
  readiness?: { kind: string; title: string; detail: string };
  canShowIssue?: (issue: MechanicalFitIssue) => boolean;
}) {
  const { problems, methodIssues } = fitProblemGroups(report.issues);
  const focusedGroup = focusedIssue
    ? problems.find((group) => group.issues.includes(focusedIssue))
    : null;
  const focusedKey =
    focusedGroup?.key ??
    (focusedIssue && (methodIssues.includes(focusedIssue) || focusedIssue.code === "coverage")
      ? "method"
      : null);
  const focusedIndex = focusedIssue && focusedGroup ? focusedGroup.issues.indexOf(focusedIssue) : 0;
  const [openKey, setOpenKey] = useState<string | null>(focusedKey);
  const [findingIndices, setFindingIndices] = useState<Record<string, number>>(
    focusedKey ? { [focusedKey]: focusedIndex } : {},
  );
  useEffect(() => {
    setOpenKey((current) =>
      focusedIssue === null && current === "blocked" ? current : focusedKey,
    );
    if (focusedKey) setFindingIndices((indices) => ({ ...indices, [focusedKey]: focusedIndex }));
  }, [focusedIssue, focusedKey, focusedIndex]);
  const openProblem = (key: string, open: boolean) => {
    setOpenKey(open ? key : null);
    if (!open) onClearIssue?.();
  };

  if (report.issues.some((issue) => issue.code === "verification-pending"))
    return (
      <section className="fd-fit-review" aria-label="Fit review">
        <p className="fd-fit-pending" role="status">
          Checking fit... Export is available when checks finish.
        </p>
      </section>
    );

  return (
    <section className="fd-fit-review fd-fit-problems" aria-label="Fit review">
      {report.status === "blocked" &&
        !report.issues.some((issue) => issue.severity === "error") && (
          <FitProblem
            title="Fit check needs attention"
            blocked
            expanded={openKey === "blocked"}
            onExpandedChange={(open) => openProblem("blocked", open)}
            onReveal={() => onClearIssue?.()}
          >
            <p>{readiness?.detail ?? "Run the fit check again before exporting."}</p>
          </FitProblem>
        )}
      {problems.map(({ key, issues }) => {
        const first = issues[0]!;
        const info = guidance[first.code];
        const index = Math.min(findingIndices[key] ?? 0, issues.length - 1);
        const issue = issues[index]!;
        const path = fitIssueBoardPath(issue.message, Object.keys(report.boardRevisions));
        const selectFinding = (next: number) => {
          const finding = issues[next];
          if (!finding) return;
          setFindingIndices((indices) => ({ ...indices, [key]: next }));
          onShowIssue(finding);
        };
        return (
          <FitProblem
            key={key}
            title={fitProblemTitle(first)}
            count={issues.length}
            blocked={first.severity === "error"}
            focused={openKey === key}
            expanded={openKey === key}
            onExpandedChange={(open) => openProblem(key, open)}
            onReveal={() => onShowIssue(issue)}
          >
            {enclosureIssueSummary[first.code] && <p>{enclosureIssueSummary[first.code]}</p>}
            {issues.length > 1 && (
              <nav className="fd-fit-finding-nav" aria-label={`${fitProblemTitle(first)} findings`}>
                <button
                  type="button"
                  aria-label="Previous finding"
                  disabled={index === 0}
                  onClick={() => selectFinding(index - 1)}
                >
                  <Icon name="chevronLeft" aria-hidden="true" />
                </button>
                <span aria-live="polite">
                  {index + 1} of {issues.length}
                </span>
                <button
                  type="button"
                  aria-label="Next finding"
                  disabled={index === issues.length - 1}
                  onClick={() => selectFinding(index + 1)}
                >
                  <Icon name="chevronRight" aria-hidden="true" />
                </button>
              </nav>
            )}
            <div className="fd-fit-finding">
              {path && (
                <strong className="fd-fit-board" title={path}>
                  {path === "board.kicad_pcb" ? "Project PCB" : enclosureFileLabel(path)}
                </strong>
              )}
              {openKey === key && partPicker}
              {enclosureIssueSummary[first.code] ? (
                <details className="fd-fit-exact" key={`${key}:${index}`}>
                  <summary>Details</summary>
                  <p>{issue.message}</p>
                </details>
              ) : (
                <p>{issue.message}</p>
              )}
              <div className="fd-fit-solution-actions">
                {info && (
                  <button
                    type="button"
                    onClick={() => {
                      onShowIssue(issue);
                      onNavigate(info.destination, issue.code, issue);
                    }}
                  >
                    {info.action}
                    <Icon name="chevronRight" aria-hidden="true" />
                  </button>
                )}
                {canShowIssue(issue) && (
                  <button
                    type="button"
                    aria-pressed={focusedIssue === issue}
                    onClick={() => onShowIssue(issue)}
                  >
                    <Icon name="search" aria-hidden="true" />
                    Show in 3D
                  </button>
                )}
              </div>
            </div>
          </FitProblem>
        );
      })}
      <FitProblem
        title="Physical fit needs checking"
        focused={openKey === "method"}
        expanded={openKey === "method"}
        onExpandedChange={(open) => openProblem("method", open)}
        onReveal={() => {
          onShowIssue(
            methodIssues[0] ?? {
              code: "coverage",
              severity: "review",
              message: "Physical fit needs checking on the assembled parts.",
            },
          );
        }}
      >
        <p>
          Try a test print before making the final case. The preview cannot guarantee a perfect fit.
        </p>
        <ul>
          <li>Close the lid without pressing on parts or cables.</li>
          <li>Check that screws or holders keep the boards in place.</li>
          <li>Try your actual plugs and cables.</li>
        </ul>
        <p>Your printer may make openings slightly smaller or larger.</p>
        {!!methodIssues.length && (
          <details className="fd-fit-check-limits">
            <summary>What was checked</summary>
            {report.geometry?.closed && (
              <p>Case geometry is joined; this does not prove physical fit.</p>
            )}
            {methodIssues.map((issue, index) => (
              <p key={index}>{issue.message}</p>
            ))}
          </details>
        )}
      </FitProblem>
    </section>
  );
}
