import { expect, test } from "bun:test";
import { closedMarkup, enterMarkup, exitMarkup, sendClearsMarkup, setMarkupTool } from "./session";
import { addStroke, type PenStroke } from "./strokes";

const stroke: PenStroke = { id: "a", tool: "pen", points: [{ x: 1, y: 1 }] };

test("enter starts empty; Esc and send both close and drop strokes", () => {
  const idle = closedMarkup();
  expect(idle).toEqual({ open: false, tool: "pen", strokes: { strokes: [] } });
  const open = enterMarkup(setMarkupTool(idle, "arrow"));
  expect(open).toEqual({ open: true, tool: "arrow", strokes: { strokes: [] } });
  const drawn = { ...open, strokes: addStroke(open.strokes, stroke) };
  expect(exitMarkup(drawn)).toEqual({ open: false, tool: "arrow", strokes: { strokes: [] } });
  expect(sendClearsMarkup(drawn)).toEqual({ open: false, tool: "arrow", strokes: { strokes: [] } });
});
