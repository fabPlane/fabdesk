import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnclosureFitReview } from "./EnclosureFitReview";
import type { MechanicalFitIssue, MechanicalFitReport } from "@fabdesk/protocol";

function render(report: MechanicalFitReport, focusedIssue: MechanicalFitIssue | null = null) {
  return renderToStaticMarkup(
    createElement(EnclosureFitReview, {
      report,
      focusedIssue,
      onNavigate: () => {},
      onShowIssue: () => {},
    }),
  );
}

function problems(html: string) {
  return Array.from(html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g), (match) => ({
    html: match[0],
    title: match[1]!.match(/<h3>(.*?)<\/h3>/)?.[1],
  }));
}

function expectSolutionState(html: string, expanded: boolean) {
  expect(html).toContain(`aria-expanded="${expanded}"`);
  const id = html.match(/aria-controls="([^"]+)"/)?.[1];
  expect(id).toBeDefined();
  const content = html.match(new RegExp(`<div[^>]*id="${id}"[^>]*>`))?.[0];
  expect(content).toBeDefined();
  expect(content!.includes("hidden=")).toBe(!expanded);
}

test("a quick shell is not presented as a completed fit check", () => {
  const html = render({
    status: "review",
    checkedBoards: 7,
    coverage: "bounds",
    boardRevisions: {},
    issues: [{ code: "verification-pending", severity: "review", message: "Shape only" }],
  });
  expect(html).toContain('role="status"');
  expect(html).toContain("Checking fit");
  expect(html).toContain("Export is available when checks finish");
  expect(html).not.toContain("Show solution");
  expect(html).not.toContain("Preview checked");
});

test("blocking problem names stay visible and come first while their solutions start collapsed", () => {
  const report: MechanicalFitReport = {
    status: "blocked",
    checkedBoards: 1,
    coverage: "Estimated bounds with native cavity checks",
    boardRevisions: { "board.kicad_pcb": "rev" },
    issues: [
      { code: "mount-none", severity: "review", message: "board.kicad_pcb: needs a holder" },
      {
        code: "native-clearance",
        severity: "error",
        message: "board.kicad_pcb: lid needs more room",
      },
    ],
  };
  const cards = problems(render(report));
  expect(cards.map((card) => card.title)).toEqual([
    "Detailed model needs more room",
    "Choose how to secure the board",
    "Physical fit needs checking",
  ]);
  const blocker = cards[0]!.html;
  expect(blocker.slice(0, blocker.indexOf(">"))).not.toContain("hidden");
  expect(blocker.indexOf("Detailed model needs more room")).toBeLessThan(
    blocker.indexOf("aria-controls"),
  );
  expect(blocker).toContain("Fix this before exporting.");
  for (const card of cards) expectSolutionState(card.html, false);
});

test("repeated findings share a problem without losing board details, unknown checks or check limits", () => {
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
  const html = render(report);
  const cards = problems(html);
  expect(cards.map((card) => card.title)).toEqual([
    "Choose how to secure the board",
    "Confirm the connector and plug",
    "Unknown future check",
    "Physical fit needs checking",
  ]);
  for (const issue of report.issues) {
    expect(html.split(issue.message)).toHaveLength(2);
  }
  expect(cards[0]!.html).toContain(report.issues[0]!.message);
  expect(cards[0]!.html).toContain(report.issues[1]!.message);
  expect(cards[3]!.html).toContain(report.issues[3]!.message);
  expect(cards[3]!.html).toContain("The preview cannot guarantee a perfect fit.");
  for (const card of cards) expectSolutionState(card.html, false);
});

test("focusing a finding opens its solution without merging a same-code blocking problem", () => {
  const required: MechanicalFitIssue = {
    code: "mount-none",
    severity: "error",
    message: "board.kicad_pcb: board retention blocks export",
  };
  const review: MechanicalFitIssue = {
    code: "mount-none",
    severity: "review",
    message: "usb.kicad_pcb: retention needs review",
  };
  const report: MechanicalFitReport = {
    status: "blocked",
    checkedBoards: 2,
    coverage: "bounds",
    boardRevisions: { "board.kicad_pcb": "rev", "usb.kicad_pcb": "rev" },
    issues: [review, required],
  };
  const cards = problems(render(report, review));
  expect(cards).toHaveLength(3);
  expectSolutionState(cards[0]!.html, false);
  expectSolutionState(cards[1]!.html, true);
  expect(cards[0]!.html).toContain(required.message);
  expect(cards[0]!.html).not.toContain(review.message);
  expect(cards[1]!.html).toContain(review.message);
  expect(cards[1]!.html).not.toContain(required.message);
});
