import { fitModelCamera } from "@fabdesk/client-core";
import { useBoardPartSelection, type PartSelectionSource } from "./usePartSelection";
import { PartSelectionBar } from "./PartSelectionBar";
import { nativeModelParts, modelPartReference } from "./model-part-selection";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { useProjectBlobUrl } from "../hooks/queries";
import { Button, Spinner } from "../components/ui";

type CameraState = { position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 };

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
    const geometry = new STLLoader().parse(bytes);
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x76b6a1, roughness: .65, metalness: .05, side: THREE.DoubleSide }));
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
  // GLTFLoader sanitizes Object3D.name (e.g. brackets). Retain exact native references.
  model.scene.traverse(object => {
    const node = model.parser.associations.get(object)?.nodes;
    const name = node === undefined ? undefined : model.parser.json.nodes?.[node]?.name;
    object.userData["nativeComponentName"] = typeof name === "string" ? name : null;
  });
  return model.scene;
}

/** View transforms affect only the camera. Model bytes and physical placement stay untouched. */
export default function ModelCanvas({ projectId, path, blob, selectionSource }: { projectId: string; path: string; blob?: Blob; selectionSource?: PartSelectionSource }) {
  const selection = useBoardPartSelection(selectionSource);
  const currentSelection = useRef(selection); currentSelection.current = selection;
  const updateSelection = useRef<(() => void) | null>(null), focusSelection = useRef<(() => void) | null>(null);
  const [selectableRefs, setSelectableRefs] = useState<string[]>([]);
  const [selectionNotice, setSelectionNotice] = useState<string | undefined>();
  useEffect(() => { updateSelection.current?.(); }, [selection.ref, selection.ready, selection.index.data]);
  const host = useRef<HTMLDivElement>(null);
  const savedCamera = useRef<CameraState | null>(null);
  const zoom = useRef<((factor: number) => void) | null>(null);
  const fit = useRef<(() => void) | null>(null);
  const query = useProjectBlobUrl(projectId, blob ? null : path);
  const data = blob ?? query.data, isPending = !blob && query.isPending, isError = !blob && query.isError, refetch = query.refetch;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const linkedFocus = useRef<number | null>(null);
  useEffect(() => {
    if (selection.linkedFocus === null || linkedFocus.current === selection.linkedFocus || loading || !selectableRefs.includes(selection.ref ?? "")) return;
    linkedFocus.current = selection.linkedFocus;
    focusSelection.current?.();
  }, [selection.linkedFocus, selection.ref, loading, selectableRefs]);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const target = host.current;
    if (!target || !data) return;
    let disposed = false;
    let renderer: THREE.WebGLRenderer | null = null;
    let controls: OrbitControls | null = null;
    let model: THREE.Object3D | null = null;
    let observer: ResizeObserver | null = null;
    let camera: THREE.PerspectiveCamera | null = null;
    let cleanupContext: (() => void) | null = null;
    let stopMotion = () => {};
    let cleanupSelection: (() => void) | null = null;
    setError(null); setLoading(true);
    void (async () => {
      try {
        if (data.size > 80 * 1024 * 1024) throw new Error("This model is too large for the canvas preview (80 MB limit). The saved file is unchanged.");
        const bytes = await data.arrayBuffer();
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
        model = await loadModel(bytes, path);
        if (disposed) { disposeModel(model); return; }
        const bounds = new THREE.Box3().setFromObject(model);
        const size = bounds.getSize(new THREE.Vector3());
        const span = Math.max(size.x, size.y, size.z);
        if (!Number.isFinite(span) || span <= 0) throw new Error("The model has no usable geometry.");
        const center = bounds.getCenter(new THREE.Vector3());
        const root = new THREE.Group(); root.add(model); root.position.copy(center).multiplyScalar(-1);
        const scene = new THREE.Scene(); scene.add(root);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x77948a, 2.5));
        const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(span, span * 2, span); scene.add(light);
        const fill = new THREE.DirectionalLight(0xc2d6ff, 1.8); fill.position.set(-span, span, -span); scene.add(fill);
        camera = new THREE.PerspectiveCamera(38, 1, span / 1000, span * 1000);
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setClearColor(0x000000, 0);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.domElement.tabIndex = 0;
        renderer.domElement.setAttribute("aria-label", "3D model. Drag to orbit, scroll to zoom, right-drag to pan. Use Fit view to reset.");
        target.append(renderer.domElement);
        controls = new OrbitControls(camera, renderer.domElement);
        controls.listenToKeyEvents(renderer.domElement);
        controls.enableDamping = false; controls.minDistance = span * .08; controls.maxDistance = span * 60;
        const render = () => { if (!disposed && renderer && camera) renderer.render(scene, camera); };
        let motionFrame = 0;
        stopMotion = () => { cancelAnimationFrame(motionFrame); motionFrame = 0; if (renderer) renderer.domElement.dataset["focusMotion"] = "idle"; };
        const reset = () => {
          stopMotion();
          if (!camera || !controls) return;
          controls.minDistance = span * .08;
          controls.target.set(0, 0, 0);
          camera.up.set(0, 1, 0);
          const { distance, direction } = fitModelCamera(size, camera.fov, camera.aspect);
          camera.position.set(distance * direction.x, distance * direction.y, distance * direction.z);
          controls.update(); render();
        };
        fit.current = reset;
        zoom.current = (factor) => {
          stopMotion();
          if (!camera || !controls) return;
          camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target);
          controls.update(); render();
        };
        const resize = () => {
          if (!renderer || !camera) return;
          const w = target.clientWidth, h = target.clientHeight;
          if (w < 1 || h < 1) return;
          renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); render();
        };
        resize();
        if (savedCamera.current) {
          camera.position.copy(savedCamera.current.position); camera.up.copy(savedCamera.current.up);
          controls.target.copy(savedCamera.current.target); controls.update(); render();
        } else reset();
        if (selectionSource) {
          const canvas = renderer.domElement;
          let selectable = new Map<string, THREE.Object3D[]>();
          const highlightBox = new THREE.Box3();
          const highlight = new THREE.Box3Helper(highlightBox, 0x1976ef);
          const highlightMaterials = Array.isArray(highlight.material) ? highlight.material : [highlight.material];
          for (const material of highlightMaterials) { material.depthTest = false; material.transparent = true; }
          highlight.renderOrder = 1000; highlight.visible = false; scene.add(highlight);
          const sync = () => {
            if (disposed || !model) return;
            const current = currentSelection.current, receipt = current.index.data?.model;
            stopMotion();
            selectable.clear(); model.updateWorldMatrix(true, true);
            if (current.ready && receipt?.sha256 === digest) {
              selectable = nativeModelParts(model, receipt.references);
            }
            setSelectableRefs([...selectable.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
            highlightBox.makeEmpty();
            for (const object of selectable.get(current.ref ?? "") ?? []) highlightBox.union(new THREE.Box3().setFromObject(object));
            highlight.visible = !highlightBox.isEmpty();
            canvas.dataset["selectedComponent"] = highlight.visible ? current.ref! : "";
            setSelectionNotice(!current.ready || receipt?.sha256 !== digest ? "Update the 3D preview to select components" : current.ref && !highlight.visible ? `${current.ref} has no selectable model in this preview` : undefined);
            render();
          };
          updateSelection.current = sync;
          focusSelection.current = () => {
            if (highlightBox.isEmpty() || !camera || !controls) return;
            const center = highlightBox.getCenter(new THREE.Vector3()), size = highlightBox.getSize(new THREE.Vector3());
            const direction = camera.position.clone().sub(controls.target).normalize();
            // Fit the selected component in the current camera orientation, not the
            // board's default angle. Tiny parts must not inherit a board-sized zoom floor.
            const distance = fitModelCamera(size, camera.fov, camera.aspect, .8, direction).distance;
            controls.minDistance = Math.max(camera.near * 4, Math.min(span * .08, distance * .1));
            stopMotion();
            const startTarget = controls.target.clone(), startPosition = camera.position.clone();
            const endPosition = center.clone().addScaledVector(direction, Math.max(distance, controls.minDistance));
            const started = performance.now(), reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
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
          const pointerDown = (event: PointerEvent) => { stopMotion(); down = event.button === 0 && event.isPrimary ? { x: event.clientX, y: event.clientY } : null; };
          const pointerUp = (event: PointerEvent) => {
            const start = down; down = null;
            if (!start || event.button !== 0 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4 || !camera || !model) return;
            const rect = canvas.getBoundingClientRect(), ray = new THREE.Raycaster();
            ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
            const ref = modelPartReference(ray.intersectObject(model, true)[0]?.object ?? null, selectable);
            if (ref) currentSelection.current.select(ref);
          };
          const cancel = () => { down = null; };
          canvas.addEventListener("pointerdown", pointerDown); canvas.addEventListener("pointerup", pointerUp); canvas.addEventListener("pointercancel", cancel);
          cleanupSelection = () => { canvas.removeEventListener("pointerdown", pointerDown); canvas.removeEventListener("pointerup", pointerUp); canvas.removeEventListener("pointercancel", cancel); highlight.geometry.dispose(); highlightMaterials.forEach(material => material.dispose()); };
          sync();
        }
        controls.addEventListener("start", stopMotion);
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
      disposed = true; stopMotion(); fit.current = null; zoom.current = null; updateSelection.current = null; focusSelection.current = null; cleanupSelection?.();
      if (camera && controls) savedCamera.current = { position: camera.position.clone(), target: controls.target.clone(), up: camera.up.clone() };
      observer?.disconnect(); cleanupContext?.(); controls?.dispose();
      if (model) disposeModel(model);
      renderer?.dispose(); renderer?.domElement.remove();
    };
  }, [data, path, retry]);

  return <div className="fd-model-canvas" data-testid="model-canvas" onKeyDown={event => { if (event.key === "Escape" && selectionSource && selection.ref && !(event.target instanceof Element && event.target.closest("input, textarea, select, [role=dialog]"))) { selection.clear(); event.preventDefault(); event.stopPropagation(); } }}>
    {selectionSource && <PartSelectionBar reference={selection.ref} references={selectableRefs} onSelect={selection.select} onClear={selection.clear} onFocus={selectableRefs.includes(selection.ref ?? "") ? () => focusSelection.current?.() : undefined} notice={selectionNotice} />}
    <div ref={host} className="fd-model-viewport" />
    {(isPending || (loading && data !== null)) && !error && !isError && <div className="fd-model-message"><Spinner /><span>Opening model…</span></div>}
    {(error || isError || data === null) && <div className="fd-model-message" role="alert"><p>{error ?? (isError ? "Could not load the saved model." : "Model file not found.")}</p><Button onClick={() => { savedCamera.current = null; setRetry((n) => n + 1); if (!blob) void refetch(); }}>Retry preview</Button></div>}
    <div className="fd-model-view-tools"><Button size="sm" title="Zoom out" aria-label="Zoom out" onClick={() => zoom.current?.(1.25)}>−</Button><Button size="sm" title="Zoom in" aria-label="Zoom in" onClick={() => zoom.current?.(.8)}>+</Button><Button size="sm" onClick={() => fit.current?.()}>Fit view</Button><span>Drag to orbit · Arrow keys pan</span></div>
  </div>;
}
