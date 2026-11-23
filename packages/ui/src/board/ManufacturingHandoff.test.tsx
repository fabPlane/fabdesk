import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrderReadiness } from "@fabdesk/protocol";
import { ManufacturingHandoffView } from "./ManufacturingHandoff";

const readiness: OrderReadiness = { ready: false, hasGerbers: true, hasFabricationZip: true, hasRouted: false, hasKicadPcb: true,
  checks: { drc: "fail", erc: "pass", fabPackage: "missing" }, reasons: ["DRC has 16 errors"], warnings: [] };
const actions = { disabled: false, onChecks: () => {}, onOrder: () => {}, onRetry: () => {} };
test("exports do not turn failing design checks into manufacturing approval", () => {
  const html = renderToStaticMarkup(<ManufacturingHandoffView {...actions} readiness={readiness} checking={false} failed={false} />);
  expect(html).toContain("Not ready to order");
  expect(html).toContain("DRC has 16 errors");
  expect(html).toContain("Review design checks");
  expect(html).toContain("Order review");
  expect(html).toContain("export draft files");
  expect(html).toContain("does not approve the design");
});
test("stale or failed readiness responses cannot present cached permission as current", () => {
  for (const state of [{ checking: true, failed: false }, { checking: false, failed: true }]) {
    const html = renderToStaticMarkup(<ManufacturingHandoffView {...actions} readiness={{ ...readiness, ready: true }} {...state} />);
    expect(html).not.toContain("saved-file order gate allows review");
    expect(html).not.toContain("DRC has 16 errors");
  }
  const html = renderToStaticMarkup(<ManufacturingHandoffView {...actions} readiness={{ ...readiness, ready: true }} checking={false} failed={false} />);
  expect(html).toContain("Confirm component stock");
  expect(html).not.toContain("Checks passed");
});
