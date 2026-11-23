import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { modelFormat, type MechanicalItem } from "@fabdesk/client-core";
import type { MechanicalBox } from "@fabdesk/protocol";
import { createFitOverlay } from "./fit-overlay";
import { assemblyClipRange, fittedCameraDistance } from "./camera-fit";
import { batchPcbGeometry } from "./batchPcbGeometry";
import { parseWorkspaceView } from "./workspace-view";
import { MeasurementOverlay } from "./measurement-overlay";
import { bindMarkupWebglCanvas, unbindMarkupWebglCanvas } from "../../markup/webgl";
import { prepareBoardPreviewMaterials } from "../board-preview-material";
import { previewPixelRatio } from "../preview-quality";
import { enclosurePreviewMaterial } from "../enclosure-preview-material";

export type BoardGeometry = {
  outline: { minX: number; minY: number; maxX: number; maxY: number };
  holes: Array<{ x: number; y: number; diameterMm: number }>;
  parts: Array<{
    ref: string;
    heightMm: number;
    bounds: BoardGeometry["outline"];
    bottom?: boolean;
  }>;
  connectors: Array<{ ref: string }>;
};
export type SceneModel = {
  item: MechanicalItem;
  data?: ArrayBuffer;
  board?: BoardGeometry;
  thickness?: number;
  origin?: [number, number, number];
  volume?: { x: number; y: number; z: number; width: number; depth: number; height: number };
  volumeColor?: number;
  guide?: { from: [number, number, number]; to: [number, number, number]; color: number };
  selectable?: boolean;
  enclosure?: boolean;
  /** Enclosure geometry can be selected without moving it; transforms require an explicit opt-in. */
  transformable?: boolean;
  post?: { diameter: number; outer: number; height: number };
};
export type SceneMode = "orbit" | "translate" | "rotate" | "measure";
type Callbacks = {
  select: (id: string | null) => void;
  transform: (
    id: string,
    position: [number, number, number],
    rotation: [number, number, number],
  ) => void;
  measured: (distance: number | null) => void;
  zoom: (percent: number) => void;
  /** Inverse camera quaternion: rotates world axes into the current camera orientation. */
  orientation?: (quaternion: [number, number, number, number]) => void;
  /** Demand-render notification for projected HTML labels. Callers should avoid unchanged state updates. */
  viewChanged?: () => void;
  error: (message: string) => void;
};
function disposeObject(object: T.Object3D) {
  object.traverse((o) => {
    if (!(o instanceof T.Mesh || o instanceof T.LineSegments || o instanceof T.Line)) return;
    if (o instanceof T.InstancedMesh) o.dispose();
    o.geometry.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      for (const v of Object.values(m))
        if (v instanceof T.Texture) {
          v.source.data?.close?.();
          v.dispose();
        }
      m.dispose();
    }
  });
}

/** Local, demand-rendered millimetre/Z-up scene. Source files are never transformed. */
export class MechanicalScene {
  private renderer: T.WebGLRenderer;
  private scene = new T.Scene();
  private camera = new T.PerspectiveCamera(38, 1, 0.01, 1e6);
  private orbit: OrbitControls;
  private gizmo: TransformControls;
  private models = new Map<string, { source: SceneModel; object: T.Group }>();
  private selection: string | null = null;
  private selectionBox: T.BoxHelper | null = null;
  private selectionOutline: T.Group | null = null;
  private selectionEdges: Array<{ line: T.LineSegments; mesh: T.Mesh }> = [];
  private selectionObject: T.Object3D | null = null;
  private hoverBox: T.BoxHelper | null = null;
  private hovered: string | null = null;
  private lastHover = 0;
  private mode: SceneMode = "orbit";
  private pointerLocked = false;
  private planarPlacement = false;
  private caseVisible = true;
  private observer: ResizeObserver;
  private disposed = false;
  private generation = 0;
  private frame = 0;
  private viewportSize = { width: 0, height: 0, pixelRatio: 0 };
  private fitDistance = 100;
  private pendingFitBox: T.Box3 | null = null;
  private viewportInsets = { left: 0, right: 0, top: 0, bottom: 0 };
  private lastZoom: number | null = null;
  private lastOrientation: T.Quaternion | null = null;
  private clippingBounds = new T.Box3();
  private explode = 0;
  private translucent = false;
  private materialOpacity = new WeakMap<
    T.Material,
    { opacity: number; transparent: boolean; depthWrite: boolean }
  >();
  private measurement: MeasurementOverlay | null = null;
  private fitOverlay: T.Group | null = null;
  private holeMarkers: T.Group | null = null;
  private spaceOutline: T.LineSegments | null = null;
  private point: T.Vector3 | null = null;
  private pointerStart = new T.Vector2();
  private draggedGizmo = false;
  private activePointers = new Set<number>();
  private themeObserver: MutationObserver;
  private environment: T.WebGLRenderTarget;
  private keyLight = new T.DirectionalLight(0xfff4df, 1.8);
  private ground = new T.Mesh(
    new T.PlaneGeometry(1, 1),
    new T.ShadowMaterial({ opacity: 0.16, depthWrite: false }),
  );
  constructor(
    private host: HTMLElement,
    private callbacks: Callbacks,
  ) {
    this.renderer = new T.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0, 0);
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    const room = new RoomEnvironment(),
      pmrem = new T.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(room, 0.04);
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = 0.7;
    room.dispose();
    pmrem.dispose();
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Interactive mechanical assembly. Drag to orbit, scroll to zoom, right-drag to pan.",
    );
    this.renderer.domElement.tabIndex = 0;
    // Preserve the last complete frame while layout changes, until the next draw.
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    host.appendChild(this.renderer.domElement);
    bindMarkupWebglCanvas(this.renderer.domElement, () => this.presentForCapture());
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(95, -125, 105);
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = false;
    this.orbit.minDistance = 0.1;
    this.orbit.maxDistance = 1e5;
    this.orbit.addEventListener("change", this.render);
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.8);
    this.gizmo.setSpace("world");
    this.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener("change", this.render);
    this.gizmo.addEventListener("dragging-changed", (e) => {
      this.orbit.enabled = !this.pointerLocked && !e.value;
      this.draggedGizmo = true;
    });
    this.gizmo.addEventListener("mouseUp", () => {
      const object = this.gizmo.object;
      if (object && this.selection && this.canTransform(this.selection))
        this.callbacks.transform(
          this.selection,
          object.position.toArray() as [number, number, number],
          [object.rotation.x, object.rotation.y, object.rotation.z].map(T.MathUtils.radToDeg) as [
            number,
            number,
            number,
          ],
        );
    });
    this.scene.add(new T.HemisphereLight(0xffffff, 0x52664c, 1.1));
    const key = this.keyLight;
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.normalBias = 0.15;
    this.scene.add(key);
    this.scene.add(key.target);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    const fill = new T.DirectionalLight(0xd8ecff, 1);
    fill.position.set(100, 70, 80);
    this.scene.add(fill);
    // Changing the drawing buffer here would clear it before the next frame paints.
    this.observer = new ResizeObserver(this.render);
    this.observer.observe(host);
    window.addEventListener("resize", this.render);
    this.themeObserver = new MutationObserver(this.render);
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-skin"],
    });
    this.renderer.domElement.addEventListener("pointerdown", this.pointerDown, true);
    this.renderer.domElement.addEventListener("pointerup", this.pointerUp);
    this.renderer.domElement.addEventListener("pointermove", this.pointerMove);
    this.renderer.domElement.addEventListener("pointerleave", this.clearHover);
    this.renderer.domElement.addEventListener("pointercancel", this.pointerInterrupted);
    this.renderer.domElement.addEventListener("lostpointercapture", this.pointerInterrupted);
    this.renderer.domElement.addEventListener("dragstart", this.preventNativeDrag);
    window.addEventListener("blur", this.interruptGesture);
    document.addEventListener("visibilitychange", this.visibilityChanged);
    this.renderer.domElement.addEventListener("webglcontextlost", this.contextLost);
  }
  private contextLost = (e: Event) => {
    e.preventDefault();
    this.callbacks.error(
      "The 3D graphics session was interrupted. Reopen the CAD tab to restore it.",
    );
  };
  private pointerDown = (e: PointerEvent) => {
    // Keep Chromium's text/image dragging from taking over the camera gesture.
    e.preventDefault();
    this.activePointers.add(e.pointerId);
    this.clearHover();
    this.renderer.domElement.focus({ preventScroll: true });
    this.pointerStart.set(e.clientX, e.clientY);
    this.draggedGizmo = false;
  };
  private preventNativeDrag = (e: Event) => e.preventDefault();
  private pointerInterrupted = (e: PointerEvent) => {
    if (this.activePointers.has(e.pointerId)) this.interruptGesture();
  };
  private visibilityChanged = () => {
    if (document.hidden) this.interruptGesture();
  };
  private interruptGesture = () => {
    if (!this.activePointers.size && !this.gizmo.dragging) return;
    const canvas = this.renderer.domElement;
    const pointers = [...this.activePointers];
    this.activePointers.clear();
    // Cancel without committing a partial transform; reset both controls' pointer bookkeeping.
    this.gizmo.dragging = false;
    this.gizmo.axis = null;
    this.gizmo.disconnect();
    this.orbit.disconnect();
    for (const id of pointers) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    this.orbit.connect(canvas);
    this.gizmo.connect(canvas);
    this.orbit.enabled = !this.pointerLocked;
    this.gizmo.enabled = !this.pointerLocked;
    this.draggedGizmo = true;
    this.updateTransforms();
    this.select(this.selection);
    this.clearHover();
    this.render();
  };
  private clearHover = () => {
    if (this.hoverBox) {
      this.scene.remove(this.hoverBox);
      disposeObject(this.hoverBox);
      this.hoverBox = null;
      this.render();
    }
    this.hovered = null;
    this.renderer.domElement.style.cursor = "";
  };
  private pointerMove = (e: PointerEvent) => {
    // Hover is a hint, never a continuous render loop or part of dragging.
    if (e.buttons || this.mode !== "orbit" || performance.now() - this.lastHover < 80) return;
    this.lastHover = performance.now();
    const r = this.renderer.domElement.getBoundingClientRect();
    const ray = new T.Raycaster();
    ray.setFromCamera(
      new T.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        1 - ((e.clientY - r.top) / r.height) * 2,
      ),
      this.camera,
    );
    const hit = ray.intersectObjects(
      [...this.models.values()]
        .filter((m) => m.object.visible && m.source.selectable !== false)
        .map((m) => m.object),
      true,
    )[0];
    let object = hit?.object;
    while (object && !object.userData["modelId"]) object = object.parent ?? undefined;
    const id = object?.userData["modelId"] as string | undefined;
    if ((id ?? null) === this.hovered) return;
    this.clearHover();
    if (id && object) {
      this.hovered = id;
      this.renderer.domElement.style.cursor = "pointer";
      if (id !== this.selection) {
        this.hoverBox = new T.BoxHelper(object, 0x7a9790);
        this.scene.add(this.hoverBox);
        this.render();
      }
    }
  };
  private pointerUp = (e: PointerEvent) => {
    if (!this.activePointers.delete(e.pointerId)) return;
    if (
      e.button !== 0 ||
      this.draggedGizmo ||
      this.pointerStart.distanceTo(new T.Vector2(e.clientX, e.clientY)) > 4
    )
      return;
    const r = this.renderer.domElement.getBoundingClientRect(),
      ray = new T.Raycaster();
    ray.setFromCamera(
      new T.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (-(e.clientY - r.top) / r.height) * 2 + 1,
      ),
      this.camera,
    );
    const hit = ray.intersectObjects(
      [...this.models.values()]
        .filter((m) => m.object.visible && m.source.selectable !== false)
        .map((m) => m.object),
      true,
    )[0];
    if (this.mode === "measure") {
      if (!hit) return;
      if (!this.point) {
        this.clearMeasure();
        this.point = hit.point.clone();
        this.callbacks.measured(null);
        this.measurement = new MeasurementOverlay(hit.point);
        this.scene.add(this.measurement);
        this.render();
      } else {
        const start = this.point;
        this.clearMeasure();
        this.measurement = new MeasurementOverlay(start, hit.point);
        this.scene.add(this.measurement);
        this.callbacks.measured(start.distanceTo(hit.point));
        this.render();
      }
      return;
    }
    let object = hit?.object;
    while (object && !object.userData["modelId"]) object = object.parent ?? undefined;
    this.callbacks.select(object?.userData["modelId"] ?? null);
  };
  private clearMeasure() {
    if (this.measurement) {
      this.scene.remove(this.measurement);
      this.measurement.dispose();
      this.measurement = null;
    }
    this.point = null;
    this.callbacks.measured(null);
  }
  render = () => {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => this.drawFrame());
  };
  /** Draw now so a canvas snapshot is not blank after the compositor discards the WebGL buffer. */
  presentForCapture = (): void => {
    if (this.disposed) return;
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.drawFrame();
  };
  private drawFrame() {
    this.frame = 0;
    if (this.disposed) return;
    const width = this.host.clientWidth,
      height = this.host.clientHeight,
      pixelRatio = previewPixelRatio(width, height, globalThis.devicePixelRatio || 1);
    if (!width || !height) return;
    const previous = this.viewportSize;
    if (
      width !== previous.width ||
      height !== previous.height ||
      pixelRatio !== previous.pixelRatio
    ) {
      // Buffer resize and draw are synchronous in this frame: no blank frame in between.
      this.renderer.setDrawingBufferSize(width, height, pixelRatio);
      this.viewportSize = { width, height, pixelRatio };
    }
    // Insets can change while hidden, even if the pane reopens at its previous size.
    this.updateViewportProjection();
    if (this.pendingFitBox) this.fitBox(this.pendingFitBox);
    this.selectionBox?.update();
    for (const { line, mesh } of this.selectionEdges) {
      mesh.updateWorldMatrix(true, false);
      line.matrix.copy(mesh.matrixWorld);
    }
    const box = this.clippingBounds.clone();
    if (this.spaceOutline) box.expandByObject(this.spaceOutline);
    if (this.gizmo.dragging && this.gizmo.object) box.expandByObject(this.gizmo.object);
    const { near, far } = assemblyClipRange(box, this.camera.position, this.camera.quaternion);
    if (near !== this.camera.near || far !== this.camera.far) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    this.measurement?.updateViewport(this.camera, this.host.clientWidth, this.host.clientHeight);
    this.renderer.render(this.scene, this.camera);
    const percent = Math.max(
      1,
      Math.round((this.fitDistance / this.camera.position.distanceTo(this.orbit.target)) * 100),
    );
    if (percent !== this.lastZoom) {
      this.lastZoom = percent;
      this.callbacks.zoom(percent);
    }
    if (this.callbacks.orientation && !this.lastOrientation?.equals(this.camera.quaternion)) {
      this.lastOrientation = this.camera.quaternion.clone();
      this.callbacks.orientation(this.camera.quaternion.clone().invert().toArray());
    }
    this.callbacks.viewChanged?.();
  }
  async setModels(sources: SceneModel[], autoFit = true) {
    if (this.gizmo.dragging) this.interruptGesture();
    this.clearHover();
    const generation = ++this.generation;
    const added: Array<{ source: SceneModel; object: T.Group }> = [];
    const failed = new Set<string>();
    const errors: string[] = [];
    try {
      for (const source of sources) {
        const existing = this.models.get(source.item.id);
        if (
          existing?.source.data === source.data &&
          existing?.source.board === source.board &&
          JSON.stringify(existing?.source.post) === JSON.stringify(source.post) &&
          JSON.stringify(existing?.source.volume) === JSON.stringify(source.volume) &&
          JSON.stringify(existing?.source.guide) === JSON.stringify(source.guide) &&
          existing?.source.volumeColor === source.volumeColor &&
          existing?.source.origin?.join() === source.origin?.join()
        )
          continue;
        let object: T.Group;
        try {
          object = await MechanicalScene.decode(source);
        } catch (e) {
          failed.add(source.item.id);
          errors.push(`${source.item.name}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        added.push({ source, object });
        if (this.disposed || generation !== this.generation) {
          added.forEach((x) => disposeObject(x.object));
          return;
        }
      }
      if (this.disposed || generation !== this.generation) {
        added.forEach((x) => disposeObject(x.object));
        return;
      }
      let changed = false;
      for (const [id, m] of this.models)
        if (
          failed.has(id) ||
          !sources.some((s) => s.item.id === id) ||
          added.some((s) => s.source.item.id === id)
        ) {
          this.scene.remove(m.object);
          disposeObject(m.object);
          this.models.delete(id);
          changed = true;
        }
      for (const m of added) {
        this.models.set(m.source.item.id, m);
        this.scene.add(m.object);
        changed = true;
      }
      for (const source of sources) {
        const m = this.models.get(source.item.id);
        if (m) m.source = source;
      }
      this.updateTransforms();
      this.select(this.selection);
      if (changed && autoFit) this.fit();
      else this.render();
      if (errors.length) this.callbacks.error(errors.join("\n"));
    } catch (e) {
      added.forEach((x) => {
        if (!this.models.has(x.source.item.id)) disposeObject(x.object);
      });
      if (!this.disposed && generation === this.generation)
        this.callbacks.error(e instanceof Error ? e.message : String(e));
    }
  }
  async validate(source: SceneModel) {
    const object = await MechanicalScene.decode(source);
    disposeObject(object);
  }
  static async validateData(path: string, data: ArrayBuffer) {
    const model = await this.decode({
      item: {
        id: "validate",
        path,
        kind: "board",
        name: "PCB",
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: 1,
        visible: true,
      },
      data,
    });
    disposeObject(model);
  }
  static async boardStl(path: string, data: ArrayBuffer): Promise<Blob> {
    const model = await this.decode({
      item: {
        id: "export",
        path,
        kind: "board",
        name: "PCB",
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: 1,
        visible: true,
      },
      data,
      origin: [0, 0, 0],
    });
    try {
      return this.worldStl(model);
    } finally {
      disposeObject(model);
    }
  }
  /** Export an immutable STL in scene millimetres, retaining the imported model's pivot, units and pose. */
  exportModelStl(id: string): Blob {
    const model = this.models.get(id);
    if (!model || model.source.item.kind !== "import" || !model.source.data)
      throw Error("Select a loaded imported STL, OBJ or GLB model to use as an enclosure.");
    return MechanicalScene.worldStl(model.object);
  }
  private static worldStl(model: T.Object3D): Blob {
    const baked = new T.Group();
    try {
      model.updateWorldMatrix(true, true);
      // STL has no transforms or mirrored-face culling. Bake each mesh and correct
      // winding after the handedness change from KiCad Y-up to PCB coordinates.
      let vertices = 0;
      const bake = (node: T.Mesh, matrix: T.Matrix4) => {
        vertices += node.geometry.getAttribute("position")?.count ?? 0;
        if (vertices > 6_000_000)
          throw Error(
            "The transformed model is too complex to export (limit: 6 million vertices).",
          );
        const geometry = node.geometry.clone().applyMatrix4(matrix);
        if (matrix.determinant() < 0) {
          const indices = geometry.index
            ? Array.from(geometry.index.array)
            : Array.from({ length: geometry.getAttribute("position").count }, (_, i) => i);
          for (let i = 0; i < indices.length; i += 3)
            [indices[i + 1], indices[i + 2]] = [indices[i + 2]!, indices[i + 1]!];
          geometry.setIndex(indices);
        }
        baked.add(new T.Mesh(geometry, new T.MeshBasicMaterial()));
      };
      model.traverse((node) => {
        if (!(node instanceof T.Mesh)) return;
        if (node instanceof T.InstancedMesh) {
          const instance = new T.Matrix4();
          for (let i = 0; i < node.count; i++) {
            node.getMatrixAt(i, instance);
            bake(node, instance.premultiply(node.matrixWorld));
          }
        } else bake(node, node.matrixWorld);
      });
      if (!baked.children.length) throw Error("The imported model has no mesh geometry to export.");
      const stl = new STLExporter().parse(baked, { binary: true });
      return new Blob([new Uint8Array(stl.buffer as ArrayBuffer, stl.byteOffset, stl.byteLength)], {
        type: "model/stl",
      });
    } finally {
      disposeObject(baked);
    }
  }
  static async decode(source: SceneModel, batch = true): Promise<T.Group> {
    const group = new T.Group();
    group.userData["modelId"] = source.item.id;
    const material = () => source.enclosure || source.item.kind === "base" || source.item.kind === "lid"
      ? enclosurePreviewMaterial()
      : new T.MeshStandardMaterial({
        color: source.item.kind === "import" ? 0xaeb7bd : 0xa5adb2,
        roughness: 0.42,
        metalness: 0.18,
        side: T.DoubleSide,
      });
    if (source.guide) {
      const g = source.guide;
      const line = new T.Line(
        new T.BufferGeometry().setFromPoints([new T.Vector3(...g.from), new T.Vector3(...g.to)]),
        new T.LineDashedMaterial({ color: g.color, dashSize: 2, gapSize: 1, depthTest: false }),
      );
      line.computeLineDistances();
      line.renderOrder = 10;
      group.add(line);
      for (const point of [g.from, g.to]) {
        const m = new T.Mesh(
          new T.SphereGeometry(1, 8, 6),
          new T.MeshBasicMaterial({ color: g.color, depthTest: false }),
        );
        m.position.fromArray(point);
        m.renderOrder = 10;
        group.add(m);
      }
    } else if (source.volume) {
      const v = source.volume;
      const geometry = new T.BoxGeometry(v.width, v.depth, v.height);
      const mesh = new T.Mesh(
        geometry,
        new T.MeshStandardMaterial({
          color: source.volumeColor ?? 0xd69b52,
          transparent: true,
          opacity: 0.25,
          depthWrite: false,
        }),
      );
      mesh.position.set(v.x + v.width / 2, v.y + v.depth / 2, v.z + v.height / 2);
      const edges = new T.LineSegments(
        new T.EdgesGeometry(geometry),
        new T.LineBasicMaterial({ color: source.volumeColor ?? 0xd69b52 }),
      );
      edges.position.copy(mesh.position);
      group.add(mesh, edges);
    } else if (source.post) {
      const p = source.post;
      const shape = new T.Shape();
      shape.absarc(0, 0, p.outer / 2, 0, Math.PI * 2, false);
      const hole = new T.Path();
      hole.absarc(0, 0, p.diameter / 2, 0, Math.PI * 2, true);
      shape.holes.push(hole);
      group.add(
        new T.Mesh(
          new T.ExtrudeGeometry(shape, { depth: p.height, bevelEnabled: false, curveSegments: 48 }),
          new T.MeshStandardMaterial({ color: 0xc5c9c3, roughness: 0.6 }),
        ),
      );
    } else if (source.board) {
      const b = source.board,
        o = b.outline,
        shape = new T.Shape();
      shape.moveTo(o.minX, o.minY);
      shape.lineTo(o.maxX, o.minY);
      shape.lineTo(o.maxX, o.maxY);
      shape.lineTo(o.minX, o.maxY);
      shape.closePath();
      for (const hole of b.holes) {
        const p = new T.Path();
        p.absarc(hole.x, hole.y, hole.diameterMm / 2, 0, Math.PI * 2, true);
        shape.holes.push(p);
      }
      const thickness = source.thickness ?? 1.6;
      group.add(
        new T.Mesh(
          new T.ExtrudeGeometry(shape, {
            depth: thickness,
            bevelEnabled: false,
            curveSegments: 24,
          }),
          new T.MeshStandardMaterial({ color: 0x12643b, roughness: 0.5, metalness: 0, envMapIntensity: .35 }),
        ),
      );
      for (const part of b.parts) {
        const p = part.bounds,
          connector = b.connectors.some((c) => c.ref === part.ref);
        const mesh = new T.Mesh(
          new T.BoxGeometry(
            Math.max(0.1, p.maxX - p.minX),
            Math.max(0.1, p.maxY - p.minY),
            part.heightMm,
          ),
          new T.MeshStandardMaterial({
            color: connector ? 0xb6bfc1 : 0x252b29,
            roughness: connector ? 0.3 : 0.65,
            metalness: connector ? 0.7 : 0.1,
          }),
        );
        mesh.position.set(
          (p.minX + p.maxX) / 2,
          (p.minY + p.maxY) / 2,
          part.bottom ? -part.heightMm / 2 : thickness + part.heightMm / 2,
        );
        group.add(mesh);
      }
    } else if (source.data) {
      const format = modelFormat(source.item.path);
      if (format === "stl") group.add(new T.Mesh(new STLLoader().parse(source.data), material()));
      else if (format === "obj") {
        const model = new OBJLoader().parse(new TextDecoder().decode(source.data));
        model.traverse((o) => {
          if (o instanceof T.Mesh) {
            for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
            o.material = material();
          }
        });
        group.add(model);
      } else if (format === "glb") {
        const manager = new T.LoadingManager();
        manager.setURLModifier((url) => {
          if (!url.startsWith("blob:") && !url.startsWith("data:"))
            throw Error("Use a self-contained GLB with embedded textures and buffers.");
          return url;
        });
        const gltf = await new GLTFLoader(manager).parseAsync(source.data, "");
        if (source.item.kind === "board") prepareBoardPreviewMaterials(gltf);
        // KiCad's GLB is Y-up with PCB +Y stored as +Z. The enclosure is PCB XY/Z-up.
        // Generic GLB uses the standard right-handed Y-up conversion instead.
        gltf.scene.scale.set(1000, 1000, source.item.kind === "board" ? -1000 : 1000);
        gltf.scene.rotation.x = Math.PI / 2;
        group.add(gltf.scene);
      } else throw Error("This model format is not supported in the assembly viewer.");
    }
    if (
      batch &&
      source.data &&
      source.item.kind === "board" &&
      modelFormat(source.item.path) === "glb"
    )
      batchPcbGeometry(group);
    let vertices = 0;
    group.traverse((o) => {
      if (o instanceof T.Mesh) {
        vertices += o.geometry.getAttribute("position")?.count ?? 0;
        o.geometry.computeBoundingBox();
      }
    });
    const bounds = new T.Box3().setFromObject(group);
    if (
      vertices > 6_000_000 ||
      bounds.isEmpty() ||
      ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)
    ) {
      disposeObject(group);
      throw Error("Model geometry is empty, invalid or too complex (limit: 6 million vertices).");
    }
    // Imported parts pivot at their centre; project board/case share the PCB's XY origin.
    const origin = source.origin
      ? new T.Vector3(...source.origin)
      : source.item.kind === "import"
        ? bounds.getCenter(new T.Vector3())
        : new T.Vector3();
    const content = new T.Group();
    while (group.children.length) content.add(group.children[0]!);
    content.position.copy(origin).negate();
    group.add(content);
    return group;
  }
  private updateTransforms() {
    this.renderer.shadowMap.needsUpdate = true;
    for (const { source, object } of this.models.values()) {
      const i = source.item;
      object.position.fromArray(i.position);
      object.rotation.set(...(i.rotation.map(T.MathUtils.degToRad) as [number, number, number]));
      if (i.kind === "lid") object.translateZ(this.explode);
      object.scale.setScalar(i.scale);
      object.visible = i.visible && (!source.enclosure || this.caseVisible);
      object.traverse((o) => {
        if (o instanceof T.Mesh) o.castShadow = true;
        if (o instanceof T.Mesh && i.kind !== "board")
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
            let original = this.materialOpacity.get(m);
            if (!original) {
              original = {
                opacity: m.opacity,
                transparent: m.transparent,
                depthWrite: m.depthWrite,
              };
              this.materialOpacity.set(m, original);
            }
            m.transparent = this.translucent || original.transparent;
            m.opacity = this.translucent ? Math.min(0.28, original.opacity) : original.opacity;
            m.depthWrite = this.translucent ? false : original.depthWrite;
          }
      });
    }
    this.updateGround();
    this.render();
  }
  private updateGround() {
    const bounds = new T.Box3();
    for (const { object } of this.models.values())
      if (object.visible) bounds.expandByObject(object);
    this.clippingBounds.copy(bounds);
    this.ground.visible = !bounds.isEmpty() && !this.translucent;
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new T.Vector3());
    const radius = Math.max(10, bounds.getSize(new T.Vector3()).length());
    this.ground.position.set(center.x, center.y, bounds.min.z - 0.3);
    this.ground.scale.setScalar(radius * 4);
    this.keyLight.position.copy(center).add(new T.Vector3(-radius, -radius, radius * 2));
    this.keyLight.target.position.copy(center);
    const camera = this.keyLight.shadow.camera;
    camera.left = camera.bottom = -radius;
    camera.right = camera.top = radius;
    camera.near = 0.1;
    camera.far = radius * 6;
    camera.updateProjectionMatrix();
  }
  private clearSelectionOutline() {
    if (this.selectionBox) {
      this.scene.remove(this.selectionBox);
      disposeObject(this.selectionBox);
      this.selectionBox = null;
    }
    if (this.selectionOutline) {
      this.scene.remove(this.selectionOutline);
      disposeObject(this.selectionOutline);
      this.selectionOutline = null;
    }
    this.selectionEdges = [];
    this.selectionObject = null;
  }
  private canTransform(id: string) {
    const source = this.models.get(id)?.source;
    return (
      !!source &&
      source.transformable !== false &&
      (!source.enclosure || source.transformable === true)
    );
  }
  private outlineSelection(object: T.Group, enclosure: boolean) {
    this.clearSelectionOutline();
    this.selectionObject = object;
    if (enclosure) {
      const meshes: T.Mesh[] = [];
      let vertices = 0;
      object.traverse((part) => {
        if (part instanceof T.Mesh) {
          meshes.push(part);
          vertices += part.geometry.getAttribute("position")?.count ?? 0;
        }
      });
      // Detailed imported meshes keep a cheap bounds highlight; generated cases use their real edges.
      if (vertices <= 300_000) {
        this.selectionOutline = new T.Group();
        for (const mesh of meshes) {
          const line = new T.LineSegments(
            new T.EdgesGeometry(mesh.geometry, 25),
            new T.LineBasicMaterial({
              color: 0x25d9d0,
              transparent: true,
              opacity: 0.95,
              depthWrite: false,
            }),
          );
          line.matrixAutoUpdate = false;
          line.renderOrder = 20;
          this.selectionOutline.add(line);
          this.selectionEdges.push({ line, mesh });
        }
        this.scene.add(this.selectionOutline);
        return;
      }
    }
    this.selectionBox = new T.BoxHelper(object, enclosure ? 0x25d9d0 : 0xaddb75);
    this.scene.add(this.selectionBox);
  }
  select(id: string | null) {
    this.clearHover();
    this.selection = id;
    this.gizmo.detach();
    const model = id ? this.models.get(id) : undefined;
    const object = model?.object;
    if (object?.visible) {
      if (this.selectionObject !== object) this.outlineSelection(object, !!model?.source.enclosure);
      if (
        this.canTransform(id!) &&
        (this.mode === "translate" || this.mode === "rotate") &&
        (!this.explode ||
          (this.planarPlacement && this.models.get(id!)?.source.item.kind === "board"))
      ) {
        this.gizmo.setMode(this.mode);
        this.gizmo.attach(object);
      }
    } else this.clearSelectionOutline();
    this.render();
  }
  setPointerLock(locked: boolean) {
    if (this.pointerLocked === locked) return;
    this.pointerLocked = locked;
    if (locked && (this.gizmo.dragging || this.activePointers.size)) this.interruptGesture();
    this.orbit.enabled = !locked;
    this.gizmo.enabled = !locked;
  }
  setMode(mode: SceneMode) {
    if (this.gizmo.dragging) this.interruptGesture();
    const changed = mode !== this.mode;
    this.mode = mode;
    this.gizmo.showX = this.gizmo.showY = !(this.planarPlacement && mode === "rotate");
    this.gizmo.showZ = true;
    if (changed) this.clearMeasure();
    this.select(this.selection);
  }
  setPlanarPlacement(value: boolean) {
    if (value === this.planarPlacement) return;
    this.planarPlacement = value;
    this.setMode(this.mode);
  }
  setCaseVisible(value: boolean) {
    this.caseVisible = value;
    this.updateTransforms();
    this.select(this.selection);
    this.render();
  }
  focusModel(id: string) {
    const box = this.bounds(id);
    if (box && !box.isEmpty()) this.fitBox(box.expandByScalar(3));
  }
  setExplode(value: number, autoFit = true) {
    this.explode = value;
    this.updateTransforms();
    this.select(this.selection);
    if (autoFit) this.fit();
    else this.render();
  }
  setTranslucent(value: boolean) {
    this.translucent = value;
    this.updateTransforms();
  }
  setFitOverlay(regions: MechanicalBox[], space: MechanicalBox | null) {
    if (this.fitOverlay) {
      this.scene.remove(this.fitOverlay);
      disposeObject(this.fitOverlay);
    }
    if (this.spaceOutline) {
      this.scene.remove(this.spaceOutline);
      disposeObject(this.spaceOutline);
    }
    this.fitOverlay = createFitOverlay(regions);
    this.scene.add(this.fitOverlay);
    this.spaceOutline = null;
    if (space) {
      const geometry = new T.BoxGeometry(space.width, space.depth, space.height);
      this.spaceOutline = new T.LineSegments(
        new T.EdgesGeometry(geometry),
        new T.LineDashedMaterial({
          color: 0x7eacbc,
          dashSize: 2,
          gapSize: 1,
          transparent: true,
          opacity: 0.7,
          depthTest: false,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      geometry.dispose();
      this.spaceOutline.computeLineDistances();
      this.spaceOutline.position.set(
        space.x + space.width / 2,
        space.y + space.depth / 2,
        space.z + space.height / 2,
      );
      this.spaceOutline.renderOrder = 19;
      this.scene.add(this.spaceOutline);
    }
    this.render();
  }
  focusFitRegions(regions: MechanicalBox[]) {
    const box = new T.Box3();
    for (const r of regions) {
      box.expandByPoint(new T.Vector3(r.x, r.y, r.z));
      box.expandByPoint(new T.Vector3(r.x + r.width, r.y + r.depth, r.z + r.height));
    }
    if (!box.isEmpty()) this.fitBox(box.expandByScalar(3));
  }
  setMountingHoles(
    holes: Array<{ x: number; y: number; z: number; diameter: number; linked: boolean }>,
  ) {
    if (this.holeMarkers) {
      this.scene.remove(this.holeMarkers);
      disposeObject(this.holeMarkers);
    }
    this.holeMarkers = new T.Group();
    for (const hole of holes) {
      const ring = new T.Mesh(
        new T.RingGeometry(hole.diameter / 2, hole.diameter / 2 + 0.45, 48),
        new T.MeshBasicMaterial({
          color: hole.linked ? 0xaddb75 : 0xe4b76e,
          side: T.DoubleSide,
          depthTest: false,
          depthWrite: false,
        }),
      );
      ring.position.set(hole.x, hole.y, hole.z);
      ring.renderOrder = 21;
      this.holeMarkers.add(ring);
    }
    this.scene.add(this.holeMarkers);
    this.render();
  }
  bounds(id: string) {
    const m = this.models.get(id);
    if (!m) return null;
    return new T.Box3().setFromObject(m.object);
  }
  /** Keep the full canvas while fitting into the area left clear by floating controls. */
  setViewportInsets(
    insets: { left?: number; right?: number; top?: number; bottom?: number },
    autoFit = true,
  ) {
    const size = (value: number | undefined) => (Number.isFinite(value) ? Math.max(0, value!) : 0);
    const next = {
      left: size(insets.left),
      right: size(insets.right),
      top: size(insets.top),
      bottom: size(insets.bottom),
    };
    if (
      (Object.keys(next) as Array<keyof typeof next>).every(
        (key) => next[key] === this.viewportInsets[key],
      )
    )
      return;
    this.viewportInsets = next;
    this.updateViewportProjection();
    if (autoFit) this.fit();
    this.render();
  }
  private viewportFrame() {
    const width = Math.max(1, this.host.clientWidth),
      height = Math.max(1, this.host.clientHeight);
    const requested = this.viewportInsets;
    const x = Math.min(1, Math.max(0, width - 200) / Math.max(1, requested.left + requested.right));
    const y = Math.min(
      1,
      Math.max(0, height - 200) / Math.max(1, requested.top + requested.bottom),
    );
    const left = requested.left * x,
      right = requested.right * x;
    const top = requested.top * y,
      bottom = requested.bottom * y;
    return {
      width,
      height,
      left,
      right,
      top,
      bottom,
      availableWidth: width - left - right,
      availableHeight: height - top - bottom,
    };
  }
  private updateViewportProjection() {
    const frame = this.viewportFrame();
    this.camera.aspect = frame.width / frame.height;
    if (frame.left || frame.right || frame.top || frame.bottom)
      this.camera.setViewOffset(
        frame.width,
        frame.height,
        -(frame.left - frame.right) / 2,
        -(frame.top - frame.bottom) / 2,
        frame.width,
        frame.height,
      );
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }
  private fittedDistance(box: T.Box3) {
    const frame = this.viewportFrame();
    const verticalFov = T.MathUtils.radToDeg(
      2 *
        Math.atan(
          (Math.tan(T.MathUtils.degToRad(this.camera.fov / 2)) * frame.availableHeight) /
            frame.height,
        ),
    );
    return T.MathUtils.clamp(
      fittedCameraDistance(
        box,
        this.camera.quaternion,
        verticalFov,
        frame.availableWidth / frame.availableHeight,
      ),
      this.orbit.minDistance,
      this.orbit.maxDistance,
    );
  }
  /** Project a world-space point to CSS pixels relative to this scene's host. Offscreen points return null. */
  projectPoint(x: number, y: number, z: number): { x: number; y: number } | null {
    if (!this.host.clientWidth || !this.host.clientHeight || ![x, y, z].every(Number.isFinite))
      return null;
    this.camera.updateMatrixWorld();
    const point = new T.Vector3(x, y, z).project(this.camera);
    if (
      ![point.x, point.y, point.z].every(Number.isFinite) ||
      Math.abs(point.x) > 1 ||
      Math.abs(point.y) > 1 ||
      Math.abs(point.z) > 1
    )
      return null;
    return {
      x: ((point.x + 1) * this.host.clientWidth) / 2,
      y: ((1 - point.y) * this.host.clientHeight) / 2,
    };
  }
  /** Project the visible model's bounds centre to CSS pixels relative to this scene's host. */
  projectModel(id: string): { x: number; y: number } | null {
    const model = this.models.get(id);
    if (!model?.object.visible) return null;
    const box = this.bounds(id);
    if (!box || box.isEmpty()) return null;
    const point = box.getCenter(new T.Vector3());
    return this.projectPoint(point.x, point.y, point.z);
  }
  fit() {
    const box = new T.Box3();
    for (const m of this.models.values()) if (m.object.visible) box.expandByObject(m.object);
    if (this.spaceOutline) box.expandByObject(this.spaceOutline);
    if (box.isEmpty()) {
      this.pendingFitBox = null;
      return;
    }
    this.fitBox(box);
  }
  private fitBox(box: T.Box3) {
    if (!this.host.clientWidth || !this.host.clientHeight) {
      // Async models can finish while a pane is hidden. Fit only once it has real dimensions.
      this.pendingFitBox = box.clone();
      return;
    }
    this.pendingFitBox = null;
    const center = box.getCenter(new T.Vector3());
    this.fitDistance = this.fittedDistance(box);
    const direction = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(direction, this.fitDistance);
    this.orbit.update();
    this.render();
  }
  zoom(factor: number) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const offset = this.camera.position.clone().sub(this.orbit.target);
    const distance = T.MathUtils.clamp(
      offset.length() * factor,
      this.orbit.minDistance,
      this.orbit.maxDistance,
    );
    this.camera.position.copy(this.orbit.target).addScaledVector(offset.normalize(), distance);
    this.orbit.update();
    this.render();
  }
  getView() {
    return { position: this.camera.position.toArray(), target: this.orbit.target.toArray() };
  }
  restoreView(value: unknown) {
    const view = parseWorkspaceView(value);
    if (!view) return false;
    this.pendingFitBox = null;
    this.camera.position.fromArray(view.position);
    this.orbit.target.fromArray(view.target);
    this.orbit.update();
    const bounds = this.clippingBounds.clone();
    if (this.spaceOutline) bounds.expandByObject(this.spaceOutline);
    if (!bounds.isEmpty()) this.fitDistance = this.fittedDistance(bounds);
    this.render();
    return true;
  }
  view(view: "iso" | "top" | "front" | "right" | "bottom" | "back" | "left") {
    const d = this.camera.position.distanceTo(this.orbit.target),
      direction =
        view === "top"
          ? new T.Vector3(0, -0.0001, 1)
          : view === "bottom"
            ? new T.Vector3(0, -0.0001, -1)
            : view === "front"
              ? new T.Vector3(0, -1, 0.0001)
              : view === "back"
                ? new T.Vector3(0, 1, 0.0001)
                : view === "right"
                  ? new T.Vector3(1, 0, 0.0001)
                  : view === "left"
                    ? new T.Vector3(-1, 0, 0.0001)
                    : new T.Vector3(1, -1, 1);
    this.camera.position.copy(this.orbit.target).addScaledVector(direction.normalize(), d);
    this.orbit.update();
    this.fit();
    this.render();
  }
  dispose() {
    this.disposed = true;
    ++this.generation;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.themeObserver.disconnect();
    this.orbit.dispose();
    this.gizmo.dispose();
    this.clearMeasure();
    if (this.fitOverlay) disposeObject(this.fitOverlay);
    if (this.holeMarkers) disposeObject(this.holeMarkers);
    if (this.spaceOutline) disposeObject(this.spaceOutline);
    this.scene.traverse((o) => {
      if (o instanceof T.Mesh || o instanceof T.LineSegments) o.geometry.dispose();
    });
    for (const m of this.models.values()) disposeObject(m.object);
    this.models.clear();
    this.renderer.domElement.removeEventListener("pointerdown", this.pointerDown, true);
    this.renderer.domElement.removeEventListener("pointerup", this.pointerUp);
    this.renderer.domElement.removeEventListener("pointermove", this.pointerMove);
    this.renderer.domElement.removeEventListener("pointerleave", this.clearHover);
    this.renderer.domElement.removeEventListener("pointercancel", this.pointerInterrupted);
    this.renderer.domElement.removeEventListener("lostpointercapture", this.pointerInterrupted);
    this.renderer.domElement.removeEventListener("dragstart", this.preventNativeDrag);
    window.removeEventListener("blur", this.interruptGesture);
    document.removeEventListener("visibilitychange", this.visibilityChanged);
    this.clearHover();
    this.clearSelectionOutline();
    this.renderer.domElement.removeEventListener("webglcontextlost", this.contextLost);
    window.removeEventListener("resize", this.render);
    unbindMarkupWebglCanvas(this.renderer.domElement);
    this.renderer.dispose();
    this.environment.dispose();
    disposeObject(this.ground);
    this.keyLight.shadow.dispose();
    this.renderer.domElement.remove();
  }
}
