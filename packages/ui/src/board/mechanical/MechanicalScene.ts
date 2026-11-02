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
  private hoverBox: T.BoxHelper | null = null;
  private hovered: string | null = null;
  private lastHover = 0;
  private mode: SceneMode = "orbit";
  private planarPlacement = false;
  private caseVisible = true;
  private observer: ResizeObserver;
  private disposed = false;
  private generation = 0;
  private frame = 0;
  private fitDistance = 100;
  private clippingBounds = new T.Box3();
  private explode = 0;
  private translucent = false;
  private materialOpacity = new WeakMap<
    T.Material,
    { opacity: number; transparent: boolean; depthWrite: boolean }
  >();
  private measurement: T.Group | null = null;
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
    host.appendChild(this.renderer.domElement);
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
      this.orbit.enabled = !e.value;
      this.draggedGizmo = true;
    });
    this.gizmo.addEventListener("mouseUp", () => {
      const object = this.gizmo.object;
      if (object && this.selection)
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
    this.observer = new ResizeObserver(() => {
      const w = host.clientWidth,
        h = host.clientHeight;
      if (!w || !h) return;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.fit();
      this.render();
    });
    this.observer.observe(host);
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
    this.orbit.enabled = true;
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
        this.measurement = new T.Group();
        const dot = new T.Mesh(
          new T.SphereGeometry(this.fitDistance * 0.003, 12, 8),
          new T.MeshBasicMaterial({ color: 0xaddb75, depthTest: false }),
        );
        dot.position.copy(hit.point);
        this.measurement.add(dot);
        this.scene.add(this.measurement);
        this.render();
      } else {
        const start = this.point;
        this.clearMeasure();
        this.measurement = new T.Group();
        const geo = new T.BufferGeometry().setFromPoints([start, hit.point]);
        this.measurement.add(
          new T.Line(geo, new T.LineBasicMaterial({ color: 0xaddb75, depthTest: false })),
        );
        for (const p of [start, hit.point]) {
          const dot = new T.Mesh(
            new T.SphereGeometry(this.fitDistance * 0.003, 12, 8),
            new T.MeshBasicMaterial({ color: 0xaddb75, depthTest: false }),
          );
          dot.position.copy(p);
          this.measurement.add(dot);
        }
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
      disposeObject(this.measurement);
      this.measurement = null;
    }
    this.point = null;
    this.callbacks.measured(null);
  }
  render = () => {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.selectionBox?.update();
      const box = this.clippingBounds.clone();
      if (this.spaceOutline) box.expandByObject(this.spaceOutline);
      if (this.gizmo.dragging && this.gizmo.object) box.expandByObject(this.gizmo.object);
      const { near, far } = assemblyClipRange(box, this.camera.position, this.camera.quaternion);
      if (near !== this.camera.near || far !== this.camera.far) {
        this.camera.near = near;
        this.camera.far = far;
        this.camera.updateProjectionMatrix();
      }
      this.renderer.render(this.scene, this.camera);
      this.callbacks.zoom(
        Math.round((this.fitDistance / this.camera.position.distanceTo(this.orbit.target)) * 100),
      );
    });
  };
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
    const baked = new T.Group();
    try {
      model.updateMatrixWorld(true);
      // STL has no transforms or mirrored-face culling. Bake each mesh and correct
      // winding after the handedness change from KiCad Y-up to PCB coordinates.
      model.traverse((node) => {
        if (!(node instanceof T.Mesh)) return;
        const geometry = node.geometry.clone().applyMatrix4(node.matrixWorld);
        if (node.matrixWorld.determinant() < 0) {
          const indices = geometry.index
            ? Array.from(geometry.index.array)
            : Array.from({ length: geometry.getAttribute("position").count }, (_, i) => i);
          for (let i = 0; i < indices.length; i += 3)
            [indices[i + 1], indices[i + 2]] = [indices[i + 2]!, indices[i + 1]!];
          geometry.setIndex(indices);
        }
        baked.add(new T.Mesh(geometry, new T.MeshBasicMaterial()));
      });
      const stl = new STLExporter().parse(baked, { binary: true });
      return new Blob([new Uint8Array(stl.buffer as ArrayBuffer)], { type: "model/stl" });
    } finally {
      disposeObject(baked);
      disposeObject(model);
    }
  }
  static async decode(source: SceneModel, batch = true): Promise<T.Group> {
    const group = new T.Group();
    group.userData["modelId"] = source.item.id;
    const material = () =>
      new T.MeshStandardMaterial({
        color: source.item.kind === "import" ? 0xaeb7bd : 0xc8cdd0,
        roughness: 0.34,
        metalness: 0.25,
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
          new T.MeshStandardMaterial({ color: 0x196e43, roughness: 0.55, metalness: 0.15 }),
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
  select(id: string | null) {
    this.clearHover();
    this.selection = id;
    this.gizmo.detach();
    if (this.selectionBox) {
      this.scene.remove(this.selectionBox);
      disposeObject(this.selectionBox);
      this.selectionBox = null;
    }
    const object = id ? this.models.get(id)?.object : undefined;
    if (object?.visible) {
      this.selectionBox = new T.BoxHelper(object, 0xaddb75);
      this.scene.add(this.selectionBox);
      if (
        (this.mode === "translate" || this.mode === "rotate") &&
        (!this.explode ||
          (this.planarPlacement && this.models.get(id!)?.source.item.kind === "board"))
      ) {
        this.gizmo.setMode(this.mode);
        this.gizmo.attach(object);
      }
    }
    this.render();
  }
  setMode(mode: SceneMode) {
    if (this.gizmo.dragging) this.interruptGesture();
    this.mode = mode;
    this.gizmo.showX = this.gizmo.showY = !(this.planarPlacement && mode === "rotate");
    this.gizmo.showZ = true;
    this.clearMeasure();
    this.select(this.selection);
  }
  setPlanarPlacement(value: boolean) {
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
  fit() {
    const box = new T.Box3();
    for (const m of this.models.values()) if (m.object.visible) box.expandByObject(m.object);
    if (this.spaceOutline) box.expandByObject(this.spaceOutline);
    if (box.isEmpty()) return;
    this.fitBox(box);
  }
  private fitBox(box: T.Box3) {
    const center = box.getCenter(new T.Vector3());
    this.fitDistance = fittedCameraDistance(
      box,
      this.camera.quaternion,
      this.camera.fov,
      this.camera.aspect,
    );
    const direction = this.camera.position.clone().sub(this.orbit.target).normalize();
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(direction, this.fitDistance);
    this.orbit.update();
    this.render();
  }
  zoom(factor: number) {
    this.camera.position.sub(this.orbit.target).multiplyScalar(factor).add(this.orbit.target);
    this.orbit.update();
    this.render();
  }
  view(view: "iso" | "top" | "front" | "right") {
    const d = this.camera.position.distanceTo(this.orbit.target),
      direction =
        view === "top"
          ? new T.Vector3(0, -0.0001, 1)
          : view === "front"
            ? new T.Vector3(0, -1, 0.0001)
            : view === "right"
              ? new T.Vector3(1, 0, 0.0001)
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
    if (this.selectionBox) disposeObject(this.selectionBox);
    this.renderer.domElement.removeEventListener("webglcontextlost", this.contextLost);
    this.renderer.dispose();
    this.environment.dispose();
    disposeObject(this.ground);
    this.keyLight.shadow.dispose();
    this.renderer.domElement.remove();
  }
}
