import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PcbModelHealth } from "./PcbModelHealth";
const base = {
  models: {},
  loading: false,
  error: "export failed",
  retry: () => {},
  readiness: null,
  setupError: "",
  fixing: false,
  fixSetup: async () => {},
  requested: 2,
};
test("missing geometry is explained prominently with a setup action", () => {
  const html = renderToStaticMarkup(createElement(PcbModelHealth, base));
  expect(html).toContain("2 boards need a 3D model");
  expect(html).toContain("Amber outlines");
  expect(html).toContain("Fix setup");
  expect(html).toContain("Retry loading");
});
test("installed compatible exporter is offered explicitly, not silently selected", () => {
  const html = renderToStaticMarkup(
    createElement(PcbModelHealth, {
      ...base,
      readiness: {
        exporter: { path: "old", version: "10.0" },
        suggested: { path: "new", version: "10.99" },
        boards: [],
        needsSetup: true,
      },
    }),
  );
  expect(html).toContain("Use KiCad 10.99 &amp; retry");
  expect(html).toContain("PCB files stay unchanged");
});
