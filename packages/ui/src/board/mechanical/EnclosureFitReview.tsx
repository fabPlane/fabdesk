import type { MechanicalFitIssue, MechanicalFitReport } from "@fabdesk/protocol";
import { enclosureFileLabel } from "@fabdesk/client-core";
import { Icon } from "../../components/Icon";

type Destination = "Start" | "Space" | "PCB";
const guidance: Record<string, { title: string; destination: Destination; action: string }> = {
  "opening-web": {
    title: "Thin wall beside a port",
    destination: "Start",
    action: "Review port spacing and case size",
  },
  "cable-route-blocked": {
    title: "A cable needs a clear path",
    destination: "Start",
    action: "Review cable space and board positions",
  },
  "screw-tool-access": {
    title: "A screw is hard to reach",
    destination: "PCB",
    action: "Review the assembly order",
  },
  "assembly-obstruction": {
    title: "A part needs a different assembly path",
    destination: "PCB",
    action: "Review placement and assembly order",
  },
  "assembly-sampled": {
    title: "Straight-down assembly sampled",
    destination: "Start",
    action: "Review assembly checks",
  },
  "assembly-unavailable": {
    title: "Assembly check is incomplete",
    destination: "Start",
    action: "Enable detailed model checks",
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
  onNavigate: (step: Destination, code: string) => void;
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
              onClick={() => onNavigate(info.destination, issue.code)}
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
      {report.geometry?.closed && (
        <p className="fd-case-message" role="status">
          <strong>Closed solids checked</strong>
          <br />
          {report.geometry.lidParts
            ? "Case and lid are each one joined piece."
            : "The case is one joined piece."}{" "}
          Physical fit still needs a printed sample.
        </p>
      )}
      <div className={`fd-fit-overview ${blocked ? "is-blocker" : "is-review"}`} role="status">
        <span className="fd-fit-status-icon">
          <Icon name={blocked ? "warning" : "search"} aria-hidden="true" />
        </span>
        <div>
          <strong>{blocked ? "Let’s fix the fit" : "Preview checked"}</strong>
          <p>
            {blocked
              ? "Fix the red items below before saving files."
              : "Look around the case, then check the notes before making it."}
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
        <details className="fd-fit-group fd-case-review-notes">
          <summary>
            Before you make it <span>{notes.length} checks</span>
          </summary>
          <p>
            Check real plugs, mounting and clearances. These notes are not a guarantee of physical
            fit.
          </p>
          {notes.map(card)}
        </details>
      )}
      <details className="fd-fit-print-note">
        <summary>Printing checklist</summary>
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
      </details>
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
