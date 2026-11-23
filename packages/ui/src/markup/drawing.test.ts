import { expect, test } from "bun:test";
import { bindMarkupDrawing, markupSvgFor, unbindMarkupDrawing } from "./drawing";

function host(svg: string, box: { x: number; y: number; w: number; h: number }, active = false): HTMLElement {
  const pane = { dataset: { active: active ? "true" : "false" } };
  const el = {
    closest(selector: string) {
      return selector === "[data-active='true']" && pane.dataset.active === "true" ? pane : null;
    },
    getBoundingClientRect() {
      return {
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        top: box.y,
        left: box.x,
        right: box.x + box.w,
        bottom: box.y + box.h,
      };
    },
  } as unknown as HTMLElement;
  bindMarkupDrawing(el, svg);
  return el;
}

function rootOf(hosts: HTMLElement[]): ParentNode {
  return {
    querySelectorAll(selector: string) {
      return selector === ".fd-svg-host" ? hosts : [];
    },
  } as unknown as ParentNode;
}

test("split compare markup uses the host that intersects the marked region", () => {
  const pcb = host("<svg id='pcb'/>", { x: 0, y: 0, w: 100, h: 80 }, true);
  const schematic = host("<svg id='sch'/>", { x: 120, y: 0, w: 100, h: 80 });
  const root = rootOf([pcb, schematic]);
  try {
    expect(markupSvgFor(root, { left: 130, top: 10, right: 160, bottom: 40 })?.svg).toContain("sch");
    expect(markupSvgFor(root, { left: 10, top: 10, right: 40, bottom: 40 })?.svg).toContain("pcb");
  } finally {
    unbindMarkupDrawing(pcb);
    unbindMarkupDrawing(schematic);
  }
});

test("split compare markup falls back to the active pane when the mark misses both hosts", () => {
  const pcb = host("<svg id='pcb'/>", { x: 0, y: 0, w: 100, h: 80 });
  const schematic = host("<svg id='sch'/>", { x: 120, y: 0, w: 100, h: 80 }, true);
  const root = rootOf([pcb, schematic]);
  try {
    expect(markupSvgFor(root)?.svg).toContain("sch");
    expect(markupSvgFor(root, { left: 400, top: 400, right: 410, bottom: 410 })?.svg).toContain("sch");
  } finally {
    unbindMarkupDrawing(pcb);
    unbindMarkupDrawing(schematic);
  }
});
