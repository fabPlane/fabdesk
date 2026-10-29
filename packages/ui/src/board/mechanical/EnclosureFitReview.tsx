import type { MechanicalFitIssue, MechanicalFitReport } from "@fabdesk/protocol";
import { enclosureFileLabel } from "@fabdesk/client-core";
import { Icon } from "../../components/Icon";

type Destination = "Start" | "Space" | "PCB";
const guidance: Record<string, { title: string; destination: Destination; action: string }> = {
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
    action: "Adjust usable space",
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

/** Presentation only: preserve the complete fit findings under Technical details. */
export function EnclosureFitReview({
  report,
  onNavigate,
  onShowIssue,
  focusedIssue,
}: {
  report: MechanicalFitReport;
  onNavigate: (step: Destination) => void;
  onShowIssue: (issue: MechanicalFitIssue) => void;
  focusedIssue: MechanicalFitIssue | null;
}) {
  const blockers = report.issues.filter((i) => i.severity === "error");
  const notes = report.issues.filter(
    (i) =>
      i.severity !== "error" && !["coverage", "import-coverage", "shell-coverage"].includes(i.code),
  );
  const blocked = report.status === "blocked" || blockers.length > 0;
  const imported = report.issues.some((i) => i.code === "import-coverage");
  const shellChecked = report.issues.some((i) => i.code === "shell-coverage");
  function card(issue: MechanicalFitIssue, index: number) {
    const info = guidance[issue.code];
    const path = Object.keys(report.boardRevisions).find((p) => issue.message.startsWith(`${p}: `));
    const detail = path ? issue.message.slice(path.length + 2) : issue.message;
    const description =
      issue.code === "board-geometry" && detail.includes("may not form a closed contour")
        ? "The board outline could not be confirmed. This preview uses a rectangular estimate."
        : detail;
    return (
      <article
        className={`fd-fit-card ${issue.severity === "error" ? "is-blocker" : "is-review"}${focusedIssue === issue ? " is-focused" : ""}`}
        key={`${issue.code}-${index}`}
      >
        <div className="fd-fit-card-heading">
          <Icon name={issue.severity === "error" ? "warning" : "search"} aria-hidden="true" />
          <h4>
            {info?.title ??
              (issue.severity === "error" ? "Fit needs attention" : "Check this detail")}
          </h4>
        </div>
        {path && (
          <span className="fd-fit-source" title={path}>
            <Icon name="pcb" aria-hidden="true" />
            {path === "board.kicad_pcb" ? "Project PCB" : enclosureFileLabel(path)}
          </span>
        )}
        <p>{description}</p>
        <div className="fd-fit-card-actions">
          {!!issue.regions?.length && (
            <button
              type="button"
              className="fd-fit-locate"
              aria-pressed={focusedIssue === issue}
              onClick={() => onShowIssue(issue)}
            >
              <Icon name="search" aria-hidden="true" />
              Show in 3D
            </button>
          )}
          {info && (
            <button
              type="button"
              className="fd-fit-link"
              onClick={() => onNavigate(info.destination)}
            >
              {info.action}
              <Icon name="chevronRight" aria-hidden="true" />
            </button>
          )}
        </div>
      </article>
    );
  }
  return (
    <section className="fd-fit-review" aria-label="Fit review summary">
      <div className={`fd-fit-overview ${blocked ? "is-blocker" : "is-review"}`} role="status">
        <span className="fd-fit-status-icon">
          <Icon name={blocked ? "warning" : "search"} aria-hidden="true" />
        </span>
        <div>
          <strong>{blocked ? "Changes needed" : "Ready to inspect"}</strong>
          <p>
            {blocked
              ? "Resolve the blockers before applying."
              : "Review the fit before you make the case."}
          </p>
        </div>
      </div>
      <dl className="fd-fit-stats">
        <div>
          <dd>{report.checkedBoards}</dd>
          <dt>{report.checkedBoards === 1 ? "Board checked" : "Boards checked"}</dt>
        </div>
        <div className={blocked ? "has-blockers" : ""}>
          <dd>{blockers.length}</dd>
          <dt>{blockers.length === 1 ? "Blocker" : "Blockers"}</dt>
        </div>
        <div>
          <dd>{notes.length}</dd>
          <dt>To review</dt>
        </div>
      </dl>
      {blockers.length > 0 && (
        <div className="fd-fit-group">
          <h3>
            Needs attention <span>Required</span>
          </h3>
          {blockers.map(card)}
        </div>
      )}
      {notes.length > 0 && (
        <div className="fd-fit-group">
          <h3>Take a closer look</h3>
          {notes.map(card)}
        </div>
      )}
      <div className="fd-fit-print-note">
        <div className="fd-fit-card-heading">
          <Icon name="checklist" aria-hidden="true" />
          <h4>Check before printing</h4>
        </div>
        <p>Sizes are estimated. Confirm these on the real parts:</p>
        <ul>
          <li>Component heights and cable space</li>
          <li>Screw access and mounting points</li>
          <li>Printer tolerances and clearances</li>
          {(imported || shellChecked) && <li>Actual fit against the imported case walls</li>}
        </ul>
        {imported && <p>Automatic checks do not include the imported shell surface.</p>}
        {shellChecked && (
          <p>
            Surface highlights use estimated part boxes. They may include empty space or mounting
            holes; inspect the real shapes.
          </p>
        )}
      </div>
      <details className="fd-fit-technical">
        <summary>Technical details</summary>
        <ul>
          {report.issues.map((i, n) => (
            <li key={n}>{i.message}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
