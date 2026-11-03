import { expect, test } from "bun:test";
import { revealEnclosureControl } from "./reveal-enclosure-control";

// A minimal DOM surface keeps these tests independent of a native window or WebGL.
type ElementStub = {
  tagName: string;
  parentElement: ElementStub | null;
  dataset: { boardPath: string };
  open: boolean;
  scrolled: boolean;
  scrollIntoView(): void;
  querySelector(): { focus(): void };
};
function node(
  tagName: string,
  parentElement: ElementStub | null = null,
  boardPath = "",
): ElementStub {
  return {
    tagName,
    parentElement,
    dataset: { boardPath },
    open: false,
    scrolled: false,
    scrollIntoView() {
      this.scrolled = true;
    },
    querySelector() {
      return { focus: () => {} };
    },
  };
}

test("opens every containing disclosure and focuses the selected board's controls", () => {
  const outer = node("DETAILS"),
    inner = node("DETAILS", outer);
  const first = node("LABEL", inner, "main.kicad_pcb");
  const second = node("LABEL", inner, "usb.kicad_pcb");
  let focused = false;
  second.querySelector = () => ({
    focus: () => {
      focused = true;
    },
  });
  const root = { querySelectorAll: () => [first, second] } as unknown as HTMLElement;
  revealEnclosureControl(root, "holders", "usb.kicad_pcb");
  expect(outer.open).toBe(true);
  expect(inner.open).toBe(true);
  expect(second.scrolled).toBe(true);
  expect(first.scrolled).toBe(false);
  expect(focused).toBe(true);
});

test("a collapsed target opens itself and a missing target leaves the page alone", () => {
  const target = node("DETAILS");
  target.querySelector = () => ({ focus: () => {} });
  revealEnclosureControl(
    { querySelectorAll: () => [target] } as unknown as HTMLElement,
    "lid-screws",
  );
  expect(target.open).toBe(true);
  expect(target.scrolled).toBe(true);
  expect(() =>
    revealEnclosureControl({ querySelectorAll: () => [] } as unknown as HTMLElement, "models"),
  ).not.toThrow();
  expect(() => revealEnclosureControl(null, "models")).not.toThrow();
});
