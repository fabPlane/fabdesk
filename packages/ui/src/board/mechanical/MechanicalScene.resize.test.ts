import { expect, test } from "bun:test";
import * as T from "three";
import { MechanicalScene } from "./MechanicalScene";

type BufferEvent = { kind: "resize"; width: number; height: number; pixelRatio: number };
type DrawEvent = { kind: "draw"; aspect: number };

function withPixelRatio(run: (setRatio: (value: number) => void) => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio");
  const setRatio = (value: number) =>
    Object.defineProperty(globalThis, "devicePixelRatio", {
      configurable: true,
      value,
      writable: true,
    });
  setRatio(1);
  try {
    run(setRatio);
  } finally {
    if (previous) Object.defineProperty(globalThis, "devicePixelRatio", previous);
    else Reflect.deleteProperty(globalThis, "devicePixelRatio");
  }
}

function harness() {
  const host = { clientWidth: 800, clientHeight: 600 };
  const camera = new T.PerspectiveCamera(38, 1, 0.01, 1000);
  camera.up.set(0, 0, 1);
  camera.position.set(83, -64, 52);
  const target = new T.Vector3(12, 8, 3);
  camera.lookAt(target);
  const events: Array<BufferEvent | DrawEvent> = [];
  const drawnViews: Array<ReturnType<MechanicalScene["getView"]>> = [];
  const models = new Map<string, { object: T.Object3D }>();
  let fits = 0;
  let queued = 0;
  const scene: MechanicalScene = Object.assign(Object.create(MechanicalScene.prototype), {
    host,
    camera,
    models,
    scene: new T.Scene(),
    renderer: {
      setDrawingBufferSize(width: number, height: number, pixelRatio: number) {
        events.push({ kind: "resize", width, height, pixelRatio });
      },
      render(_scene: T.Scene, view: T.PerspectiveCamera) {
        events.push({ kind: "draw", aspect: view.aspect });
        drawnViews.push({ position: view.position.toArray(), target: target.toArray() });
      },
    },
    viewportSize: { width: 0, height: 0, pixelRatio: 0 },
    viewportInsets: { left: 0, right: 0, top: 0, bottom: 0 },
    pendingFitBox: null,
    frame: 0,
    disposed: false,
    orbit: {
      target,
      minDistance: 0.1,
      maxDistance: 1e5,
      update() {
        camera.lookAt(target);
      },
    },
    gizmo: { dragging: false },
    clippingBounds: new T.Box3(new T.Vector3(0, 0, 0), new T.Vector3(50, 35, 12)),
    selectionEdges: [],
    fitDistance: 120,
    lastZoom: null,
    lastOrientation: null,
    callbacks: { zoom() {}, viewChanged() {} },
    fit() {
      fits++;
      MechanicalScene.prototype.fit.call(scene);
    },
    render() {
      queued++;
    },
  });
  const internals = scene as unknown as {
    drawFrame(): void;
    disposed: boolean;
    viewportSize: { width: number; height: number; pixelRatio: number };
  };
  return {
    scene,
    host,
    camera,
    target,
    models,
    events,
    drawnViews,
    internals,
    fits: () => fits,
    queued: () => queued,
  };
}

function addBoard(state: ReturnType<typeof harness>) {
  const board = new T.Mesh(new T.BoxGeometry(100, 60, 8));
  board.position.set(70, 40, 4);
  state.models.set("board", { object: board });
}

test("each resized WebGL buffer is redrawn in the same frame with the new projection", () => {
  withPixelRatio(() => {
    const state = harness();
    for (const [width, height] of [
      [800, 600],
      [640, 800],
      [1440, 900],
    ] as const) {
      state.events.length = 0;
      state.host.clientWidth = width;
      state.host.clientHeight = height;
      state.internals.drawFrame();
      expect(state.events).toEqual([
        { kind: "resize", width, height, pixelRatio: 1 },
        { kind: "draw", aspect: width / height },
      ]);
      // A cleared buffer cannot be left waiting for a second scheduled frame.
      expect(state.queued()).toBe(0);
    }
  });
});

test("camera and overlay redraws do not clear an unchanged drawing buffer", () => {
  withPixelRatio(() => {
    const state = harness();
    state.internals.drawFrame();
    state.events.length = 0;
    state.internals.drawFrame();
    state.internals.drawFrame();
    expect(state.events).toEqual([
      { kind: "draw", aspect: 800 / 600 },
      { kind: "draw", aspect: 800 / 600 },
    ]);
  });
});

test("temporarily hidden panes preserve their last usable buffer and resume drawing", () => {
  withPixelRatio(() => {
    const state = harness();
    state.internals.drawFrame();
    state.events.length = 0;
    state.host.clientWidth = 0;
    state.internals.drawFrame();
    state.host.clientWidth = 800;
    state.host.clientHeight = 0;
    state.internals.drawFrame();
    expect(state.events).toEqual([]);
    expect(state.internals.viewportSize).toEqual({ width: 800, height: 600, pixelRatio: 1 });
    state.host.clientHeight = 600;
    state.internals.drawFrame();
    expect(state.events).toEqual([{ kind: "draw", aspect: 800 / 600 }]);
  });
});

test("moving to a different density display updates the buffer once and caps its density", () => {
  withPixelRatio((setRatio) => {
    const state = harness();
    state.internals.drawFrame();
    state.events.length = 0;
    setRatio(2);
    state.internals.drawFrame();
    expect(state.events).toEqual([
      { kind: "resize", width: 800, height: 600, pixelRatio: 2 },
      { kind: "draw", aspect: 800 / 600 },
    ]);
    state.events.length = 0;
    setRatio(3);
    state.internals.drawFrame();
    expect(state.events).toEqual([{ kind: "draw", aspect: 800 / 600 }]);
  });
});

test("ordinary window resizing preserves the user's pan, orientation and zoom distance", () => {
  withPixelRatio(() => {
    const state = harness();
    const pose = state.scene.getView();
    const orientation = state.camera.quaternion.toArray();
    const distance = state.camera.position.distanceTo(state.target);
    for (const [width, height] of [
      [1200, 800],
      [400, 900],
      [1600, 600],
    ] as const) {
      state.host.clientWidth = width;
      state.host.clientHeight = height;
      state.internals.drawFrame();
      expect(state.scene.getView()).toEqual(pose);
      expect(state.camera.quaternion.toArray()).toEqual(orientation);
      expect(state.camera.position.distanceTo(state.target)).toBe(distance);
    }
    expect(state.fits()).toBe(0);
  });
});

test("responsive control insets can update projection without refitting the camera", () => {
  withPixelRatio(() => {
    const state = harness();
    state.internals.drawFrame();
    const pose = state.scene.getView();
    state.scene.setViewportInsets({ left: 300, bottom: 76 }, false);
    expect(state.fits()).toBe(0);
    expect(state.camera.view?.enabled).toBe(true);
    expect(state.scene.getView()).toEqual(pose);
    expect(state.queued()).toBe(1);
    state.scene.setViewportInsets({ right: 390, bottom: 76 });
    expect(state.fits()).toBe(1);
  });
});

test("a queued frame cannot resize or draw a disposed scene", () => {
  withPixelRatio(() => {
    const state = harness();
    state.internals.disposed = true;
    state.internals.drawFrame();
    expect(state.events).toEqual([]);
  });
});

test("inset changes while hidden use the real projection when reopened at the same size", () => {
  withPixelRatio(() => {
    const state = harness();
    state.internals.drawFrame();
    state.events.length = 0;
    state.host.clientWidth = 0;
    state.host.clientHeight = 0;
    state.scene.setViewportInsets({ left: 300, bottom: 76 }, false);
    state.host.clientWidth = 800;
    state.host.clientHeight = 600;
    state.internals.drawFrame();
    expect(state.events).toEqual([{ kind: "draw", aspect: 800 / 600 }]);
    expect(state.camera.view).toMatchObject({
      enabled: true,
      fullWidth: 800,
      fullHeight: 600,
      width: 800,
      height: 600,
      offsetX: -150,
      offsetY: 38,
    });
  });
});

test("a requested fit waits for visible dimensions and applies once before drawing", () => {
  withPixelRatio(() => {
    const state = harness();
    const reference = harness();
    for (const item of [state, reference]) {
      addBoard(item);
      item.internals.drawFrame();
      item.scene.setViewportInsets({ left: 300, bottom: 76 }, false);
    }
    reference.scene.fit();
    const pose = state.scene.getView();
    state.host.clientWidth = 0;
    state.host.clientHeight = 0;
    state.scene.fit();
    expect(state.scene.getView()).toEqual(pose);
    // A failed restore must not discard the pending fit.
    expect(state.scene.restoreView({ position: [0, 0, 0] })).toBe(false);
    state.host.clientWidth = 800;
    state.host.clientHeight = 600;
    state.events.length = 0;
    state.internals.drawFrame();
    expect(state.scene.getView()).toEqual(reference.scene.getView());
    expect(state.drawnViews.at(-1)).toEqual(reference.scene.getView());
    expect(state.events).toEqual([{ kind: "draw", aspect: 800 / 600 }]);
    state.scene.zoom(1.4);
    const zoomed = state.scene.getView();
    state.internals.drawFrame();
    expect(state.scene.getView()).toEqual(zoomed);
  });
});

test("restoring a saved camera cancels a hidden pane's pending fit", () => {
  withPixelRatio(() => {
    const state = harness();
    addBoard(state);
    state.host.clientWidth = 0;
    state.host.clientHeight = 0;
    state.scene.fit();
    const saved: ReturnType<MechanicalScene["getView"]> = {
      position: [180, -100, 120],
      target: [20, 30, 4],
    };
    expect(state.scene.restoreView(saved)).toBe(true);
    state.host.clientWidth = 800;
    state.host.clientHeight = 600;
    state.internals.drawFrame();
    expect(state.scene.getView()).toEqual(saved);
    expect(state.drawnViews.at(-1)).toEqual(saved);
  });
});

test("an empty assembly cancels an obsolete fit queued while hidden", () => {
  withPixelRatio(() => {
    const state = harness();
    addBoard(state);
    state.host.clientWidth = 0;
    state.host.clientHeight = 0;
    state.scene.fit();
    const pose = state.scene.getView();
    state.models.clear();
    state.scene.fit();
    state.host.clientWidth = 800;
    state.host.clientHeight = 600;
    state.internals.drawFrame();
    expect(state.scene.getView()).toEqual(pose);
  });
});
