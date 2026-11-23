import { fitModelCamera } from "@fabdesk/client-core";
import { alignBoardCamera, restoreBoardCamera, type BoardCameraMode, type SavedBoardCamera } from "./board-camera-mode";
import { BoardInspectionMaterials, prepareBoardPreviewMaterials } from "./board-preview-material";
import { BoardComponentVisibility, modelObjectVisible } from "./board-component-visibility";
import { previewPixelRatio } from "./preview-quality";
import { enclosurePreviewMaterial } from "./enclosure-preview-material";
import { batchPreviewMeshes } from "./preview-mesh-batching";
import { previewFrame } from "./preview-frame";
import { previewInteraction } from "./preview-interaction";
import { useBoardPartSelection, type PartSelectionSource } from "./usePartSelection";
import { PartSelectionBar } from "./PartSelectionBar";
import { nativeModelParts, modelPartReference, ModelPartTint } from "./model-part-selection";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { useProjectBlobUrl } from "../hooks/queries";
import { Button, Spinner } from "../components/ui";

type CameraState = { position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; minDistance: number; board: SavedBoardCamera | null };

function disposeModel(root: THREE.Object3D) {
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      material.dispose();
    }
  });
  for (const texture of textures) texture.dispose();
}

/** Standalone files only. Referenced remote resources are never requested by model previews. */
async function loadModel(bytes: ArrayBuffer, path: string): Promise<THREE.Object3D> {
  if (/\.stl$/i.test(path)) {
    let geometry: THREE.BufferGeometry;
    try { geometry = new STLLoader().parse(bytes); }
    catch { throw new Error("This STL is empty or invalid. Choose another file, or replace it with a valid ASCII or binary STL and retry."); }
    if (!geometry.getAttribute("position")?.count) {
      geometry.dispose();
      throw new Error("This STL contains no triangles to display. Choose another file, or replace it and retry.");
    }
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, enclosurePreviewMaterial());
    mesh.rotation.x = -Math.PI / 2; // STL convention: Z up; display only, never rewrite the source.
    return mesh;
  }
  if (/\.obj$/i.test(path)) return new OBJLoader().parse(new TextDecoder().decode(bytes));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (!url.startsWith("data:") && !url.startsWith("blob:")) throw new Error("This model references another file. Use a self-contained GLB for preview.");
    return url;
  });
  const model = await new GLTFLoader(manager).parseAsync(bytes, "");
  prepareBoardPreviewMaterials(model);
  // GLTFLoader sanitizes Object3D.name (e.g. brackets). Retain exact native references.
  model.scene.traverse(object => {
    const node = model.parser.associations.get(object)?.nodes;
    const name = node === undefined ? undefined : model.parser.json.nodes?.[node]?.name;
    object.userData["nativeComponentName"] = typeof name === "string" ? name : null;
  });
  if (!model.animations.length) batchPreviewMeshes(model.scene);
  return model.scene;
}

/** View transforms affect only the camera. Model bytes and physical placement stay untouched. */
export default function ModelCanvas({ projectId, path, blob, selectionSource, selectionToolbar, viewMode, side = "top", viewRevision = 0, showComponents = true }: { projectId: string; path: string; blob?: Blob; selectionSource?: PartSelectionSource; selectionToolbar?: HTMLElement | null; viewMode?: "2d" | "3d"; side?: "top" | "bottom"; viewRevision?: number; showComponents?: boolean }) {
  const requestedComponents = useRef(showComponents); requestedComponents.current = showComponents;
  const changeComponents = useRef<(() => void) | null>(null);
  useEffect(() => { changeComponents.current?.(); }, [showComponents]);
  const requestedView = useRef({ viewMode, side, viewRevision }); requestedView.current = { viewMode, side, viewRevision };
  const changeView = useRef<(() => void) | null>(null);
  useEffect(() => { changeView.current?.(); }, [viewMode, side, viewRevision]);
  const selection = useBoardPartSelection(selectionSource);
  const currentSelection = useRef(selection); currentSelection.current = selection;
  const updateSelection = useRef<(() => void) | null>(null), focusSelection = useRef<((animate?: boolean) => void) | null>(null);
  const [modelParts, setModelParts] = useState<ReturnType<typeof nativeModelParts> | null>(null);
  const [selectionNotice, setSelectionNotice] = useState<string | undefined>();
  useEffect(() => { updateSelection.current?.(); }, [selection.ref, selection.ready, selection.index.data]);
  const host = useRef<HTMLDivElement>(null);
  const savedCamera = useRef<CameraState | null>(null);
  const framedSelection = useRef<{ scope: string; ref: string | null } | null>(null);
  const zoom = useRef<((factor: number) => void) | null>(null);
  const fit = useRef<(() => void) | null>(null);
  const query = useProjectBlobUrl(projectId, blob ? null : path);
  const data = blob ?? query.data, isPending = !blob && query.isPending, isError = !blob && query.isError, refetch = query.refetch;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const linkedFocus = useRef<number | null>(null);
  useEffect(() => {
    if (selection.linkedFocus === null || linkedFocus.current === selection.linkedFocus || loading || !modelParts?.has(selection.ref ?? "")) return;
    linkedFocus.current = selection.linkedFocus;
    focusSelection.current?.();
  }, [selection.linkedFocus, selection.ref, loading, modelParts]);
  const [retry, setRetry] = useState(0);
  const viewUnavailable = loading || !!error || isPending || isError || !data;

  useEffect(() => {
    const target = host.current;
    setModelParts(null);
    if (!target || !data) return;
    let disposed = false;
    let renderer: THREE.WebGLRenderer | null = null;
    let controls: OrbitControls | null = null;
    let model: THREE.Object3D | null = null;
    let observer: ResizeObserver | null = null;
    let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera | null = null;
    let appliedView: BoardCameraMode | null = null;
    let cleanupContext: (() => void) | null = null;
    let stopMotion = () => {};
    let cleanupSelection: (() => void) | null = null;
    let inspectionMaterials: BoardInspectionMaterials | null = null;
    let environment: THREE.WebGLRenderTarget | null = null;
    let stopRendering = () => {};
    let stopInput = () => {};
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    setError(null); setLoading(true);
    void (async () => {
      try {
        if (data.size > 80 * 1024 * 1024) throw new Error("This model is too large for the canvas preview (80 MB limit). The saved file is unchanged.");
        const bytes = await data.arrayBuffer();
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
        model = await loadModel(bytes, path);
        if (disposed) { disposeModel(model); return; }
        inspectionMaterials = new BoardInspectionMaterials(model);
        const componentVisibility = new BoardComponentVisibility(model);
        componentVisibility.setAssembled(requestedComponents.current);
        const bounds = new THREE.Box3().setFromObject(model);
        const size = bounds.getSize(new THREE.Vector3());
        const span = Math.max(size.x, size.y, size.z);
        if (!Number.isFinite(span) || span <= 0) throw new Error("The model has no usable geometry.");
        const center = bounds.getCenter(new THREE.Vector3());
        const root = new THREE.Group(); root.add(model); root.position.copy(center).multiplyScalar(-1);
        const scene = new THREE.Scene(); scene.add(root);
        const ambient = new THREE.HemisphereLight(0xffffff, 0xb7c5bc, .8); scene.add(ambient);
        const studio = new THREE.Group(); studio.scale.setScalar(span); scene.add(studio);
        const light = new THREE.DirectionalLight(0xffffff, 1.6); light.position.set(-1, 1.5, 2); studio.add(light, light.target);
        const fill = new THREE.DirectionalLight(0xffffff, .45); fill.position.set(1, -.5, 1); studio.add(fill, fill.target);
        camera = new THREE.PerspectiveCamera(38, 1, span / 1000, span * 1000);
        // OrbitControls captures the up axis at construction. Match the shared
        // board camera so top/bottom views can orbit immediately in 3D.
        if (requestedView.current.viewMode) camera.up.set(0, 0, -1);
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setClearColor(0x000000, 0);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.NeutralToneMapping;
        const room = new RoomEnvironment(), pmrem = new THREE.PMREMGenerator(renderer);
        try { environment = pmrem.fromScene(room, .04); scene.environment = environment.texture; scene.environmentIntensity = .55; }
        finally { room.dispose(); pmrem.dispose(); }
        renderer.domElement.tabIndex = 0;
        renderer.domElement.setAttribute("aria-label", "3D model. Drag to orbit, scroll to zoom, right-drag to pan. Use Fit view to reset.");
        target.append(renderer.domElement);
        controls = new OrbitControls(camera, renderer.domElement);
        controls.listenToKeyEvents(renderer.domElement);
        controls.enableDamping = false; controls.minDistance = span * .08; controls.maxDistance = span * 60;
        let measureSelection = () => {};
        let interacting = false, renderedWidth = 0, renderedHeight = 0, renderedRatio = 0;
        const selectionIsFramed = () => framedSelection.current !== null && framedSelection.current.scope === currentSelection.current.scope && framedSelection.current.ref === currentSelection.current.ref;
        const frames = previewFrame(() => { if (!disposed && renderer && camera) {
          const w = target.clientWidth, h = target.clientHeight;
          if (w < 1 || h < 1) return;
          const ratio = previewPixelRatio(w, h, devicePixelRatio, interacting);
          if (w !== renderedWidth || h !== renderedHeight || ratio !== renderedRatio) {
            renderer.setDrawingBufferSize(w, h, ratio);
            renderedWidth = w; renderedHeight = h; renderedRatio = ratio;
          }
          // Soft light from the viewer's upper left, on both sides of the board.
          studio.position.copy(controls?.target ?? root.position); studio.quaternion.copy(camera.quaternion);
          renderer.render(scene, camera); measureSelection();
        } });
        const render = frames.render;
        stopRendering = frames.dispose;
        stopInput = previewInteraction(renderer.domElement, render);
        let motionFrame = 0;
        stopMotion = () => { cancelAnimationFrame(motionFrame); motionFrame = 0; if (renderer) renderer.domElement.dataset["focusMotion"] = "idle"; };
        const reset = () => {
          stopMotion();
          if (!camera || !controls) return;
          framedSelection.current = null;
          controls.minDistance = span * .08;
          controls.target.set(0, 0, 0);
          if (camera instanceof THREE.OrthographicCamera) {
            const aspect = Math.max(.1, target.clientWidth / Math.max(1, target.clientHeight));
            const half = Math.max(size.z, size.x / aspect) * .6;
            camera.left = -half * aspect; camera.right = half * aspect; camera.top = half; camera.bottom = -half;
            camera.zoom = 1; camera.up.set(0, 0, -1);
            camera.position.set(0, requestedView.current.side === "bottom" ? -span * 3 : span * 3, 0);
            camera.updateProjectionMatrix(); controls.update(); render(); return;
          }
          camera.up.set(0, 1, 0);
          const { distance, direction } = fitModelCamera(size, 38, target.clientWidth / Math.max(1, target.clientHeight));
          camera.position.set(distance * direction.x, distance * direction.y, distance * direction.z);
          controls.update(); render();
        };
        fit.current = reset;
        zoom.current = (factor) => {
          framedSelection.current = null; stopMotion();
          if (!camera || !controls) return;
          if (camera instanceof THREE.OrthographicCamera) { camera.zoom /= factor; camera.updateProjectionMatrix(); }
          else camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target);
          controls.update(); render();
        };
        const resize = () => frames.renderWith(() => {
          if (!renderer || !camera) return;
          const w = target.clientWidth, h = target.clientHeight;
          if (w < 1 || h < 1) return;
          // CSS stretches the previous image during layout; the buffer changes
          // only when its replacement is ready to draw in this same frame.
          if (camera instanceof THREE.PerspectiveCamera) camera.aspect = w / h;
          else { const half = (camera.top - camera.bottom) / 2; camera.left = -half * w / h; camera.right = half * w / h; }
          camera.updateProjectionMatrix();
          if (selectionIsFramed()) focusSelection.current?.(false);
        });
        resize();
        if (savedCamera.current) {
          controls.minDistance = savedCamera.current.minDistance;
          camera.position.copy(savedCamera.current.position); camera.up.copy(savedCamera.current.up);
          controls.target.copy(savedCamera.current.target); controls.update(); render();
        } else reset();
        if (selectionSource) {
          const canvas = renderer.domElement;
          let indexedReferences: readonly string[] | null = null;
          let parts: ReturnType<typeof nativeModelParts> | null = null;
          const highlightBox = new THREE.Box3();
          const tint = new ModelPartTint();
          measureSelection = () => {
            if (!camera || highlightBox.isEmpty()) { delete canvas.dataset["componentBounds"]; return; }
            const points = [];
            for (const x of [highlightBox.min.x, highlightBox.max.x]) for (const y of [highlightBox.min.y, highlightBox.max.y]) for (const z of [highlightBox.min.z, highlightBox.max.z]) points.push(new THREE.Vector3(x, y, z).project(camera));
            canvas.dataset["componentBounds"] = JSON.stringify({ left:Math.min(...points.map(p=>p.x)), right:Math.max(...points.map(p=>p.x)), top:Math.max(...points.map(p=>p.y)), bottom:Math.min(...points.map(p=>p.y)) });
          };
          const sync = () => {
            if (disposed || !model) return;
            const current = currentSelection.current, receipt = current.index.data?.model;
            // Revalidating unchanged source bytes must not forget a focused part.
            // Keep intent across loading/model replacement, but never across scope
            // or reference changes, and never render an unverified highlight.
            if (!selectionIsFramed()) framedSelection.current = null;
            stopMotion();
            const references = requestedComponents.current && current.ready && receipt?.sha256 === digest ? receipt.references : null;
            if (references !== indexedReferences) {
              indexedReferences = references;
              parts = references ? nativeModelParts(model, references) : null;
              setModelParts(parts);
            }
            const selectedObjects = parts?.get(current.ref ?? "") ?? [];
            highlightBox.makeEmpty();
            for (const object of selectedObjects) highlightBox.union(new THREE.Box3().setFromObject(object));
            const visible = !highlightBox.isEmpty();
            canvas.dataset["tintedMeshes"] = String(tint.apply(selectedObjects));
            canvas.dataset["selectedComponent"] = visible ? current.ref! : "";
            setSelectionNotice(!requestedComponents.current ? undefined : !current.ready || receipt?.sha256 !== digest ? "Preview updating · component selection will return automatically" : current.ref && !visible ? `${current.ref} has no selectable model in this preview` : undefined);
            if (visible && selectionIsFramed()) focusSelection.current?.(false);
            render();
          };
          updateSelection.current = sync;
          focusSelection.current = (animate = true) => {
            if (highlightBox.isEmpty() || !camera || !controls) return;
            framedSelection.current = { scope: currentSelection.current.scope, ref: currentSelection.current.ref };
            const center = highlightBox.getCenter(new THREE.Vector3()), size = highlightBox.getSize(new THREE.Vector3());
            if (camera instanceof THREE.OrthographicCamera) {
              camera.zoom = Math.min((camera.right - camera.left) / Math.max(.1, size.x * 1.3), (camera.top - camera.bottom) / Math.max(.1, size.z * 1.3));
              camera.updateProjectionMatrix();
            }
            const direction = camera.position.clone().sub(controls.target).normalize();
            // Fit the selected component in the current camera orientation, not the
            // board's default angle. Tiny parts must not inherit a board-sized zoom floor.
            const distance = fitModelCamera(size, 38, target.clientWidth / Math.max(1, target.clientHeight), .8, direction).distance;
            controls.minDistance = Math.max(camera.near * 4, Math.min(span * .08, distance * .1));
            stopMotion();
            const startTarget = controls.target.clone(), startPosition = camera.position.clone();
            const endPosition = center.clone().addScaledVector(direction, Math.max(distance, controls.minDistance));
            const started = performance.now(), reduced = !animate || matchMedia("(prefers-reduced-motion: reduce)").matches;
            const step = (now: number) => {
              if (disposed || !camera || !controls) return;
              const t = reduced ? 1 : Math.min(1, (now - started) / 320), eased = 1 - (1 - t) ** 3;
              controls.target.lerpVectors(startTarget, center, eased); camera.position.lerpVectors(startPosition, endPosition, eased); controls.update(); render();
              canvas.dataset["focusMotion"] = t < 1 ? "running" : "idle";
              if (t < 1) motionFrame = requestAnimationFrame(step); else motionFrame = 0;
            };
            step(started);
          };
          let down: { x: number; y: number } | null = null;
          const pointerDown = (event: PointerEvent) => { framedSelection.current = null; stopMotion(); down = event.button === 0 && event.isPrimary ? { x: event.clientX, y: event.clientY } : null; };
          const pointerUp = (event: PointerEvent) => {
            const start = down; down = null;
            if (!start || event.button !== 0 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4 || !camera || !model) return;
            const rect = canvas.getBoundingClientRect(), ray = new THREE.Raycaster();
            ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
            if (!parts) return;
            const ref = modelPartReference(ray.intersectObject(model, true).find(hit => modelObjectVisible(hit.object))?.object ?? null, parts);
            if (ref) currentSelection.current.select(ref);
          };
          const cancel = () => { down = null; };
          // OrbitControls emits `start` for pointer/wheel gestures, but not keys.
          // A keyboard pan/rotation must take control away from linked focus too.
          // Run after its key handler and repaint even below its `change` threshold:
          // millimeter-scale close-ups can pan visibly without emitting `change`.
          const keyDown = (event: KeyboardEvent) => {
            if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) { framedSelection.current = null; stopMotion(); render(); }
          };
          canvas.addEventListener("keydown", keyDown);
          canvas.addEventListener("pointerdown", pointerDown); canvas.addEventListener("pointerup", pointerUp); canvas.addEventListener("pointercancel", cancel);
          cleanupSelection = () => { canvas.removeEventListener("keydown", keyDown); canvas.removeEventListener("pointerdown", pointerDown); canvas.removeEventListener("pointerup", pointerUp); canvas.removeEventListener("pointercancel", cancel); tint.clear(); };
          sync();
        }
        // Display-only switch: reuse geometry/materials and keep the current orbit,
        // pan and zoom. Selection intent survives, but hidden parts cannot focus.
        changeComponents.current = () => {
          stopMotion();
          componentVisibility.setAssembled(requestedComponents.current);
          updateSelection.current?.();
          render();
        };
        const perspective = camera;
        let flat: THREE.OrthographicCamera | null = null;
        let previousView: BoardCameraMode | null = null;
        const setView = () => {
          if (!controls || !renderer || !perspective) return;
          stopMotion();
          const isFlat = requestedView.current.viewMode === "2d";
          inspectionMaterials?.setFlat(isFlat);
          // The inspection view favors legible ink and pad boundaries over
          // specular highlights; 3D retains directional shape and metal reflections.
          ambient.intensity = isFlat ? 1.15 : .8;
          light.intensity = isFlat ? .85 : 1.6;
          fill.intensity = isFlat ? .3 : .45;
          scene.environmentIntensity = isFlat ? .3 : .55;
          if (requestedView.current.viewMode) {
            if (!flat) {
              const aspect = Math.max(.1, target.clientWidth / Math.max(1, target.clientHeight));
              const half = Math.max(size.z, size.x / aspect) * .6;
              flat = new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, span / 1000, span * 1000);
              flat.up.set(0, 0, -1); flat.position.set(0, span * 3, 0);
              const saved = savedCamera.current?.board;
              if (saved) { restoreBoardCamera(flat, controls.target, saved); previousView = saved.view; }
            }
            const next = { mode: requestedView.current.viewMode, side: requestedView.current.side, revision: requestedView.current.viewRevision };
            alignBoardCamera(flat, controls.target, next, previousView);
            previousView = next;
            appliedView = next;
            camera = flat;
          } else camera = perspective;
          controls.object = camera;
          controls.enableRotate = !isFlat;
          controls.mouseButtons.LEFT = isFlat ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
          renderer.domElement.setAttribute("aria-label", isFlat ? `${requestedView.current.side} board view. Drag to pan, scroll to zoom.` : "3D model. Drag to orbit, scroll to zoom, right-drag to pan.");
          renderer.domElement.dataset["viewMode"] = isFlat ? "2d" : "3d";
          controls.update(); resize(); render();
        };
        changeView.current = setView;
        if (requestedView.current.viewMode) setView();
        controls.addEventListener("start", () => {
          framedSelection.current = null; stopMotion(); clearTimeout(settleTimer);
          interacting = true; render();
        });
        controls.addEventListener("end", () => {
          clearTimeout(settleTimer);
          settleTimer = setTimeout(() => { interacting = false; render(); }, 140);
        });
        controls.addEventListener("change", render);
        observer = new ResizeObserver(resize); observer.observe(target);
        const lost = (event: Event) => { event.preventDefault(); setError("The 3D graphics connection was interrupted. Retry to reopen the preview."); };
        renderer.domElement.addEventListener("webglcontextlost", lost);
        cleanupContext = () => renderer?.domElement.removeEventListener("webglcontextlost", lost);
        setLoading(false);
      } catch (failure) {
        if (!disposed) { setError(failure instanceof Error ? failure.message : "Could not open the model preview."); setLoading(false); }
      }
    })();
    return () => {
      disposed = true; clearTimeout(settleTimer); changeView.current = null; changeComponents.current = null; stopMotion(); stopInput(); stopRendering(); fit.current = null; zoom.current = null; updateSelection.current = null; focusSelection.current = null; cleanupSelection?.();
      if (camera && controls) savedCamera.current = {
        position: camera.position.clone(), target: controls.target.clone(), up: camera.up.clone(), minDistance: controls.minDistance,
        board: camera instanceof THREE.OrthographicCamera && appliedView ? { camera: camera.clone(), target: controls.target.clone(), view: appliedView } : null,
      };
      observer?.disconnect(); cleanupContext?.(); controls?.dispose();
      inspectionMaterials?.dispose();
      if (model) disposeModel(model);
      environment?.dispose();
      renderer?.dispose(); renderer?.domElement.remove();
    };
  }, [data, path, retry]);

  return <div className="fd-model-canvas" data-testid="model-canvas" onKeyDown={event => { if (event.key === "Escape" && selectionSource && selection.ref && !(event.target instanceof Element && event.target.closest("input, textarea, select, [role=dialog]"))) { selection.clear(); event.preventDefault(); event.stopPropagation(); } }}>
    {selectionSource && <PartSelectionBar target={selectionToolbar} reference={selection.ref} references={selection.ready && modelParts ? selection.index.data?.references ?? [] : []} onSelect={selection.select} onClear={selection.clear} onFocus={modelParts?.has(selection.ref ?? "") ? () => focusSelection.current?.() : undefined} notice={selectionNotice} />}
    <div ref={host} className="fd-model-viewport" />
    {(isPending || (loading && data !== null)) && !error && !isError && <div className="fd-model-message" role="status"><Spinner /><span>Opening model…</span></div>}
    {(error || isError || data === null) && <div className="fd-model-message" role="alert"><p>{error ?? (isError ? "Could not load the saved model." : "Model file not found.")}</p><Button onClick={() => { savedCamera.current = null; setRetry((n) => n + 1); if (!blob) void refetch(); }}>Retry preview</Button></div>}
    <div className="fd-model-view-tools"><Button size="sm" title="Zoom out" aria-label="Zoom out" disabled={viewUnavailable} onClick={() => zoom.current?.(1.25)}>−</Button><Button size="sm" title="Zoom in" aria-label="Zoom in" disabled={viewUnavailable} onClick={() => zoom.current?.(.8)}>+</Button><Button size="sm" disabled={viewUnavailable} onClick={() => fit.current?.()}>Fit view</Button><span>{viewMode === "2d" ? "Drag to pan · Scroll to zoom" : "Drag to orbit · Arrow keys pan"}</span></div>
  </div>;
}
