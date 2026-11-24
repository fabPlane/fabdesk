import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkupOverlay } from "./Overlay";
import { useUiStore } from "../stores/ui";

test("markup overlay renders pen, arrow and undo while open", () => {
  const initial = useUiStore.getInitialState();
  const previous = { ...initial };
  Object.assign(initial, { markupOpen: true, markupTool: "pen" });
  try {
    const html = renderToStaticMarkup(<MarkupOverlay />);
    expect(html).toContain('data-testid="markup-overlay"');
    expect(html).toContain("Pen");
    expect(html).toContain("Arrow");
    expect(html).toContain("Undo last stroke");
    expect(html).toContain("Esc to exit");
  } finally {
    Object.assign(initial, previous);
  }
});

test("markup overlay is absent when the mode is off", () => {
  const initial = useUiStore.getInitialState();
  const previous = { ...initial };
  Object.assign(initial, { markupOpen: false });
  try {
    expect(renderToStaticMarkup(<MarkupOverlay />)).toBe("");
  } finally {
    Object.assign(initial, previous);
  }
});

test("markup overlay stays off on DOM-only tabs even if the mode flag is set", () => {
  const initial = useUiStore.getInitialState();
  const previous = { ...initial };
  Object.assign(initial, { markupOpen: true, boardTab: "notes", workspaceArea: "files" });
  try {
    expect(renderToStaticMarkup(<MarkupOverlay />)).toBe("");
  } finally {
    Object.assign(initial, previous);
  }
});
