import { expect, test } from "bun:test";
import { OrthographicCamera } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { previewFrame } from "./preview-frame";
import { previewInteraction } from "./preview-interaction";

function move(canvas: EventTarget, buttons: number, pointerType = "mouse") {
  canvas.dispatchEvent(Object.assign(new Event("pointermove"), { buttons, pointerType }));
}

test("small PCB pans redraw even when OrbitControls suppresses its change event", () => {
  const camera = new OrthographicCamera(-.02, .02, .01, -.01, .00001, 10);
  camera.up.set(0, 0, -1); camera.position.set(0, .12, 0);
  const controls = new OrbitControls(camera, null);
  controls.enableRotate = false;
  const canvas = new EventTarget();
  const callbacks: FrameRequestCallback[] = [];
  let draws = 0;
  const frames = previewFrame(() => draws++, fn => { callbacks.push(fn); return callbacks.length; }, () => {});
  controls.addEventListener("change", frames.render);
  const cleanup = previewInteraction(canvas as HTMLElement, frames.render);
  // 0.1 mm is several screen pixels on this board, below the controls' 1 mm threshold.
  camera.position.x += .0001; controls.target.x += .0001;
  expect(controls.update()).toBe(false);
  expect(callbacks.length).toBe(0);
  move(canvas, 1);
  move(canvas, 1);
  expect(callbacks.length).toBe(1);
  callbacks[0]!(0); expect(draws).toBe(1);
  cleanup(); controls.removeEventListener("change", frames.render); frames.dispose();
});

test("mouse hover stays idle; mouse drag, touch and wheel redraw; cleanup removes handlers", () => {
  const canvas = new EventTarget(); let draws = 0;
  const cleanup = previewInteraction(canvas as HTMLElement, () => draws++);
  move(canvas, 0); expect(draws).toBe(0);
  move(canvas, 1); move(canvas, 2); move(canvas, 4);
  move(canvas, 0, "touch"); canvas.dispatchEvent(new Event("wheel"));
  expect(draws).toBe(5);
  cleanup(); move(canvas, 1); canvas.dispatchEvent(new Event("wheel"));
  expect(draws).toBe(5);
});
