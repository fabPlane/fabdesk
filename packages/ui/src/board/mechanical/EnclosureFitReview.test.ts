import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnclosureFitReview } from "./EnclosureFitReview";
import type { MechanicalFitReport } from "@fabdesk/protocol";

test("a quick shell is not presented as a completed fit check", () => {
  const html = renderToStaticMarkup(
    createElement(EnclosureFitReview, {
      report: {
        status: "review",
        checkedBoards: 7,
        coverage: "bounds",
        boardRevisions: {},
        issues: [{ code: "verification-pending", severity: "review", message: "Shape only" }],
      },
      focusedIssue: null,
      onNavigate: () => {},
      onShowIssue: () => {},
    }),
  );
  expect(html).toContain("Case shape is ready");
  expect(html).toContain("checks must finish before export");
  expect(html).not.toContain("Boards checked");
  expect(html).not.toContain("Preview checked");
});

test("simplified review keeps blocking errors outside collapsed optional checks", () => {
  const report: MechanicalFitReport = {
    status: "blocked",
    checkedBoards: 1,
    coverage: "Estimated bounds with native cavity checks",
    boardRevisions: { "board.kicad_pcb": "rev" },
    issues: [
      {
        code: "native-clearance",
        severity: "error",
        message: "board.kicad_pcb: lid needs more room",
      },
      { code: "mount-none", severity: "review", message: "board.kicad_pcb: needs a holder" },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(EnclosureFitReview, {
      report,
      focusedIssue: null,
      onNavigate: () => {},
      onShowIssue: () => {},
    }),
  );
  const notes = html.indexOf('<details class="fd-fit-group fd-case-review-notes"');
  expect(notes).toBeGreaterThan(0);
  expect(html.indexOf("Detailed model needs more room")).toBeLessThan(notes);
  expect(html.indexOf("Choose how to secure the board")).toBeGreaterThan(notes);
  expect(html).toContain("Fix the red items below before saving files.");
  expect(html).not.toContain('fd-case-review-notes" open');
});

test("plain-language tasks preserve every original finding and hide the long report initially", () => {
  const report: MechanicalFitReport = {
    status: "review",
    checkedBoards: 2,
    coverage: "bounds",
    boardRevisions: { "board.kicad_pcb": "rev", "usb.kicad_pcb": "rev" },
    issues: [
      {
        code: "mount-none",
        severity: "review",
        message: "board.kicad_pcb: no aligned supporting screw posts.",
      },
      {
        code: "mount-none",
        severity: "review",
        message: "usb.kicad_pcb: no aligned supporting screw posts.",
      },
      {
        code: "port-measurements",
        severity: "review",
        message: "usb.kicad_pcb: J2 dimensions are missing or assumed.",
      },
      {
        code: "assembly-sampled",
        severity: "review",
        message: "No obstruction at 12 sampled positions.",
      },
      {
        code: "unknown-future-check",
        severity: "review",
        message: "A new limitation that must remain visible.",
      },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(EnclosureFitReview, {
      report,
      focusedIssue: null,
      onNavigate: () => {},
      onShowIssue: () => {},
    }),
  );
  expect(html).toContain("Secure the boards");
  expect(html).toContain("Check plug space");
  expect(html).toContain("Other checks");
  expect(html).toContain("This board needs screws or a holder to stay in place.");
  expect(html).toContain("The port or plug size is estimated.");
  expect(html).toContain("<dd>3</dd><dt>Check types</dt>");
  expect(html).toContain("Full check report · 5 findings");
  expect(html).not.toContain('fd-fit-technical" open');
  expect(html).not.toContain('fd-fit-report-entry" open');
  for (const issue of report.issues) expect(html).toContain(issue.message);
  expect(html).toContain("The preview cannot guarantee a perfect fit.");
});
