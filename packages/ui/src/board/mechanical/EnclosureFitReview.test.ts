import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnclosureFitReview, fitProblemCount, fitProblemGroups } from "./EnclosureFitReview";
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

test("repeated findings share one card and are available one at a time without losing check limits", () => {
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
  expect(cards[0]!.html).toContain(report.issues[0]!.message);
  expect(cards[0]!.html).not.toContain(report.issues[1]!.message);
  expect(cards[0]!.html).toContain('aria-label="2 findings"');
  expect(cards[0]!.html).toContain("1 of 2");
  const selected = problems(render(report, report.issues[1]!));
  expect(selected[0]!.html).toContain(report.issues[1]!.message);
  expect(selected[0]!.html).not.toContain(report.issues[0]!.message);
  expect(selected[0]!.html).toContain("2 of 2");
  expectSolutionState(selected[0]!.html, true);
  for (const card of selected.slice(1)) expectSolutionState(card.html, false);
  expect(cards[2]!.html).toContain(report.issues[4]!.message);
  expect(cards[3]!.html).toContain(report.issues[3]!.message);
  expect(cards[3]!.html).toContain("The preview cannot guarantee a perfect fit.");
  for (const card of cards) expectSolutionState(card.html, false);
});

test("every repeated finding can be selected with correct paging boundaries and its own details", () => {
  const report: MechanicalFitReport = {
    status: "review",
    checkedBoards: 1,
    coverage: "bounds",
    boardRevisions: { "board.kicad_pcb": "rev" },
    issues: Array.from({ length: 12 }, (_, i) => ({
      code: "detailed-missing",
      severity: "review",
      message: `board.kicad_pcb: model C${i + 1} is unavailable.`,
    })),
  };
  const groups = fitProblemGroups(report.issues);
  expect(groups.problems).toHaveLength(1);
  expect(groups.problems[0]!.issues).toEqual(report.issues);
  expect(fitProblemCount(report)).toBe(2);
  for (const [index, finding] of report.issues.entries()) {
    const cards = problems(render(report, finding));
    expect(cards).toHaveLength(2);
    expect(cards[0]!.html).toContain('aria-label="12 findings"');
    expect(cards[0]!.html).toContain(`${index + 1} of 12`);
    expect(cards[0]!.html.match(/class="fd-fit-finding"/g)).toHaveLength(1);
    for (const other of report.issues) {
      expect(cards[0]!.html.includes(other.message)).toBe(other === finding);
    }
    const previous = cards[0]!.html.match(/<button[^>]*aria-label="Previous finding"[^>]*>/)?.[0];
    const next = cards[0]!.html.match(/<button[^>]*aria-label="Next finding"[^>]*>/)?.[0];
    expect(previous?.includes("disabled=")).toBe(index === 0);
    expect(next?.includes("disabled=")).toBe(index === report.issues.length - 1);
    expectSolutionState(cards[0]!.html, true);
    expectSolutionState(cards[1]!.html, false);
  }
});

test("the review badge count matches rendered problem cards, including fallback blockers and pending checks", () => {
  const base: MechanicalFitReport = {
    status: "blocked",
    checkedBoards: 0,
    coverage: "bounds",
    boardRevisions: {},
    issues: [],
  };
  expect(fitProblemCount(base)).toBe(problems(render(base)).length);
  expect(fitProblemCount(base)).toBe(2);
  const pending: MechanicalFitReport = {
    ...base,
    issues: [{ code: "verification-pending", severity: "review", message: "Checking" }],
  };
  expect(fitProblemCount(pending)).toBe(0);
  expect(problems(render(pending))).toHaveLength(0);
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
