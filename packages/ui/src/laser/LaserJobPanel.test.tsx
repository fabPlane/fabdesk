import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LaserJobView } from "@fabdesk/client-core";
import { FieldPreview } from "./LaserJobPanel";

const job = (over: Partial<LaserJobView> = {}): LaserJobView => ({
  name: "logo", source: "file", boardMm: { width: 20, height: 10 }, positionMm: { x: 5, y: -3 }, positionFromJob: true, fieldMm: 70,
  settings: { powerPct: 20, speedMmPerS: 1000, frequencyKhz: 40, passes: 1, intervalMm: 0.03, angleDeg: 0, angleStepDeg: 0 }, edge: null,
  estimatedSeconds: 12, preview: { fills: [[[0, 0], [20, 0], [20, 10], [0, 10]], [[5, 2], [15, 2], [15, 8], [5, 8]]], lines: [[[0, 12], [20, 12]]] }, warnings: [], ...over,
});

test("the lens preview draws the job where it will be marked: field centred on 0,0, Y up, job centre at its position", () => {
  const html = renderToStaticMarkup(<FieldPreview job={job()} onPlace={() => undefined} disabled={false} />);
  expect(html).toContain('viewBox="-35 -35 70 70"');
  expect(html).toContain('transform="scale(1,-1)"');
  expect(html).toContain('transform="translate(-5,-8)"'); // centre (5,-3) minus half of 20 × 10
  expect(html).toContain('fill-rule="evenodd"'); // the inner ring is a hole
  expect(html).toContain("M0,12L20,12"); // a line, not closed
  expect(html).toContain("X 5, Y -3");
});

test("while the laser runs the preview cannot be clicked to move the job", () => {
  expect(renderToStaticMarkup(<FieldPreview job={job()} onPlace={() => undefined} disabled />)).toContain("data-disabled");
});
