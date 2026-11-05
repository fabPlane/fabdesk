import { fitModelCamera } from "@fabdesk/client-core";
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
  return model.scene;
}

/** View transforms affect only the camera. Model bytes and physical placement stay untouched. */
export default function ModelCanvas({ projectId, path, blob }: { projectId: string; path: string; blob?: Blob }) {
  const host = useRef<HTMLDivElement>(null);
  const savedCamera = useRef<CameraState | null>(null);
  const zoom = useRef<((factor: number) => void) | null>(null);
  const fit = useRef<(() => void) | null>(null);
  const query = useProjectBlobUrl(projectId, blob ? null : path);
  const data = blob ?? query.data, isPending = !blob && query.isPending, isError = !blob && query.isError, refetch = query.refetch;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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
    setError(null); setLoading(true);
    void (async () => {
      try {
        if (data.size > 80 * 1024 * 1024) throw new Error("This model is too large for the canvas preview (80 MB limit). The saved file is unchanged.");
        model = await loadModel(await data.arrayBuffer(), path);
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
        const reset = () => {
          if (!camera || !controls) return;
          controls.target.set(0, 0, 0);
          camera.up.set(0, 1, 0);
          const { distance, direction } = fitModelCamera(size, camera.fov, camera.aspect);
          camera.position.set(distance * direction.x, distance * direction.y, distance * direction.z);
          controls.update(); render();
        };
        fit.current = reset;
        zoom.current = (factor) => {
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
      disposed = true; fit.current = null; zoom.current = null;
      if (camera && controls) savedCamera.current = { position: camera.position.clone(), target: controls.target.clone(), up: camera.up.clone() };
      observer?.disconnect(); cleanupContext?.(); controls?.dispose();
      if (model) disposeModel(model);
      renderer?.dispose(); renderer?.domElement.remove();
    };
  }, [data, path, retry]);

  return <div className="fd-model-canvas" data-testid="model-canvas">
    <div ref={host} className="fd-model-viewport" />
    {(isPending || (loading && data !== null)) && !error && !isError && <div className="fd-model-message"><Spinner /><span>Opening model…</span></div>}
    {(error || isError || data === null) && <div className="fd-model-message" role="alert"><p>{error ?? (isError ? "Could not load the saved model." : "Model file not found.")}</p><Button onClick={() => { savedCamera.current = null; setRetry((n) => n + 1); if (!blob) void refetch(); }}>Retry preview</Button></div>}
    <div className="fd-model-view-tools"><Button size="sm" title="Zoom out" aria-label="Zoom out" onClick={() => zoom.current?.(1.25)}>−</Button><Button size="sm" title="Zoom in" aria-label="Zoom in" onClick={() => zoom.current?.(.8)}>+</Button><Button size="sm" onClick={() => fit.current?.()}>Fit view</Button><span>Drag to orbit · Arrow keys pan</span></div>
  </div>;
}
