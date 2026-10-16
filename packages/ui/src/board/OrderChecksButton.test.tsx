import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrderReadiness } from "@fabdesk/protocol";
import { OrderChecksButton } from "./OrderChecksButton";

function render(drc: OrderReadiness["checks"]["drc"], erc: OrderReadiness["checks"]["erc"], ready = false, unavailable = false) {
  return renderToStaticMarkup(<OrderChecksButton order={{ ready, checks: { drc, erc }, hasGerbers: true, hasFabricationZip: false, hasRouted: false, hasKicadPcb: true, reasons: [], warnings: [] }} unavailable={unavailable} onClick={() => {}} />);
}

test("only current passing required checks get a green checkmark", () => {
  expect(render("pass", "pass", true)).toContain('data-status="passed"');
  expect(render("pass", "not_required", true)).toContain("Checks passed");
  expect(render("pass", "missing", false)).toContain('data-status="unchecked"');
  expect(render("not_required", "not_required", true)).toContain('data-status="unchecked"');
});

test("missing checks stay neutral; failed, stale and non-applicable checks ask for review", () => {
  expect(render("missing", "missing")).toContain("Order checks");
  for (const state of ["fail", "stale", "not_applicable"] as const) {
    expect(render("pass", state, state === "not_applicable")).toContain('data-status="review"');
    expect(render("pass", state)).toContain("Review issues");
  }
});

test("a failed refresh does not present cached results as verified", () => {
  expect(render("pass", "pass", true, true)).toContain('data-status="unchecked"');
});
