import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CadRuntimeState } from "@fabdesk/protocol";
import {
  useCoreClient,
  useProject,
  useProjects,
  mechanicalItem,
  enclosureErrorMessage,
  enclosurePose,
  parseMechanicalLayout,
  validateModelFile,
  validateEnclosureFile,
  decodeMesh,
  MECHANICAL_LAYOUT_PATH,
  type MechanicalItem,
} from "@fabdesk/client-core";
import {
  MechanicalScene,
  type BoardGeometry,
  type SceneModel,
  type SceneMode,
} from "./MechanicalScene";
import { Dialog } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { CircuitLogo } from "../../components/CircuitLogo";
import { useUiStore } from "../../stores/ui";
import { MechanicalIcon } from "./MechanicalIcon";
import { MechanicalViewCube } from "./MechanicalViewCube";
import { EnclosureDesigner, type EnclosureWorkspaceController } from "./EnclosureDesigner";
import { detailedBoardSource, usePcbModels } from "./usePcbModels";
import { PcbModelStatus } from "./PcbModelStatus";
import "./mechanical.css";
import "./mechanical-entry.css";

type EnclosureResult = {
  mesh?: string;
  format?: string;
  exists?: boolean;
  pcbRevision?: string;
  previewOnly?: boolean;
  params?: Record<string, number | string | boolean>;
  board?: { geometry?: BoardGeometry; thicknessMm?: number; pcbRevision?: string };
  features?: { geometry?: BoardGeometry; thicknessMm?: number; pcbRevision?: string };
  meshes?: { base: string; lid: string };
  stl?: string;
  lidStl?: string;
  step?: string;
  alignment?: { ok: boolean; stale: boolean; issues?: Array<{ message: string }> };
  warnings?: string[];
  cutouts?: unknown[];
};
type Form = {
  clearanceMm: number;
  wallMm: number;
  outlineOffsetMm: number;
  headroomMm: number;
  ventPattern: string;
  ventFaces: string;
  snapFit: boolean;
};
const DEFAULTS: Form = {
  clearanceMm: 1,
  wallMm: 2,
  outlineOffsetMm: 0,
  headroomMm: 1.5,
  ventPattern: "none",
  ventFaces: "lid",
  snapFit: false,
};
function result(value: unknown): EnclosureResult {
  const r = value as { json?: EnclosureResult; result?: { json?: EnclosureResult } };
  const data = r.json ?? r.result?.json ?? (r.result as EnclosureResult) ?? {};
  const board = data.board ?? data.features;
  return { ...data, ...(board ? { board } : {}) };
}
const tuple = (values: number[]) => values as [number, number, number];
const message = enclosureErrorMessage;

function ImportToolIcon({ name }: { name: "move" | "align" | "measure" }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "move" ? (
        <path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />
      ) : name === "align" ? (
        <>
          <path d="M12 3v18M3 12h18" />
          <rect x="5" y="5" width="5" height="5" rx="1" />
          <rect x="14" y="14" width="5" height="5" rx="1" />
        </>
      ) : (
        <>
          <path d="m3 16 13-13 5 5L8 21l-5-5Z" />
          <path d="m13 6 2 2m-5 1 2 2m-5 1 2 2m-5 1 2 2" />
        </>
      )}
    </svg>
  );
}

/** Commit one undoable edit on blur; allow temporary '-' and decimal text while typing. */
function TransformNumber({
  label,
  value,
  min = -1e6,
  max = 1e6,
  step = 0.1,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <input
      aria-label={label}
      type="number"
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const n = Number(draft);
        if (draft.trim() && Number.isFinite(n) && n >= min && n <= max) {
          if (n !== value) onCommit(n);
        } else setDraft(String(value));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(String(value));
          e.stopPropagation();
        }
      }}
    />
  );
}

export function MechanicalWorkspace({
  projectId,
  advanced,
  cadRuntime = null,
}: {
  projectId: string;
  advanced: ReactNode;
  cadRuntime?: CadRuntimeState | null;
}) {
  const client = useCoreClient(),
    project = useProject(projectId),
    projects = useProjects();
  const setActiveProject = useUiStore((s) => s.setActiveProject);
  const boardVisible = useUiStore((s) => s.boardOpen && !s.activeOpenSourceId && !s.inventoryOpen);
  const enclosureController = useRef<EnclosureWorkspaceController | null>(null);
  const [sharedBoardModels, setSharedBoardModels] = useState<SceneModel[]>([]);
  const [hiddenSharedBoards, setHiddenSharedBoards] = useState<Set<string>>(() => new Set());
  const [workspaceTab, setWorkspaceTab] = useState<"assembly" | "connections">("assembly");
  const [enclosureContext, setEnclosureContext] = useState<string | null>(null);
  const [enclosureReviewCount, setEnclosureReviewCount] = useState(0);
  const [enclosureHistory, setEnclosureHistory] = useState({ canUndo: false, canRedo: false });
  const [importDetailsOpen, setImportDetailsOpen] = useState(false);
  const [unitScale, setUnitScale] = useState(1);
  const [alignTarget, setAlignTarget] = useState("");
  const [confirmedScales, setConfirmedScales] = useState<Record<string, number>>({});
  const [formatsOpen, setFormatsOpen] = useState(false);
  const [stepRetry, setStepRetry] = useState<{ path: string; name: string } | null>(null);
  const onConnectionsChange = useCallback(
    (open: boolean) => setWorkspaceTab(open ? "connections" : "assembly"),
    [],
  );
  const lastSceneModels = useRef("");
  const loadedProject = useRef<string | null>(null);
  const historyScope = useRef<"assembly" | "enclosure">("assembly");
  const host = useRef<HTMLDivElement>(null),
    scene = useRef<MechanicalScene | null>(null),
    input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<MechanicalItem[]>([]),
    itemsRef = useRef(items);
  const [sources, setSources] = useState<SceneModel[]>([]),
    buffers = useRef(new Map<string, ArrayBuffer>());
  const [status, setStatus] = useState<EnclosureResult>({}),
    [preview, setPreview] = useState<EnclosureResult | null>(null);
  const [form, setForm] = useState<Form>(DEFAULTS),
    previewForm = useRef<Form | null>(null);
  const [selected, setSelected] = useState<string | null>(null),
    [mode, setMode] = useState<SceneMode>("orbit");
  const panelKey = `fd:mechanical:panel:${client.baseUrl}:${projectId}`;
  const [panel, setPanel] = useState<"add" | "generate" | "design" | "assembly" | null>(() => {
      try {
        const saved = sessionStorage.getItem(panelKey);
        return saved === "design" ? saved : "add";
      } catch {
        return "add";
      }
    }),
    [advancedOpen, setAdvancedOpen] = useState(false);
  useEffect(() => {
    try {
      sessionStorage.setItem(panelKey, panel ?? "add");
    } catch {
      /* Optional view preference. */
    }
  }, [panelKey, panel]);
  const [enclosureStatus, setEnclosureStatus] = useState("Loading enclosure…");
  const [expanded, setExpanded] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [partFilter, setPartFilter] = useState("");
  const [modelRevision, setModelRevision] = useState(0);
  const [dimensions, setDimensions] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<[number, number, number, number]>([0, 0, 0, 1]);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState<string | null>(null),
    [saveState, setSaveState] = useState("Loading…");
  const [loaded, setLoaded] = useState(false),
    [revision, setRevision] = useState(0),
    [zoom, setZoom] = useState(100),
    [explode, setExplode] = useState(0),
    [ghost, setGhost] = useState(false),
    [measured, setMeasured] = useState<number | null>(null),
    [showReview, setShowReview] = useState(false);
  const live = useRef(true),
    saveQueue = useRef(Promise.resolve()),
    saveVersion = useRef(0),
    history = useRef<MechanicalItem[][]>([]),
    future = useRef<MechanicalItem[][]>([]),
    [, setHistoryVersion] = useState(0);
  const lifecycle = useRef(new AbortController());
  const operation = useRef(false);
  const assemblyBoards = useMemo(
    () =>
      sharedBoardModels.map((model) => ({
        ...model,
        item: {
          ...model.item,
          visible: model.item.visible && !hiddenSharedBoards.has(model.item.id),
        },
      })),
    [sharedBoardModels, hiddenSharedBoards],
  );
  const assemblyItems = useMemo(
    () => [
      ...items.filter((item) => item.kind !== "board" || !assemblyBoards.length),
      ...assemblyBoards.filter((model) => model.item.kind === "board").map((model) => model.item),
    ],
    [items, assemblyBoards],
  );
  const current = assemblyItems.find((i) => i.id === selected),
    view = preview ?? status;
  const currentTransformable =
    assemblyBoards.find((model) => model.item.id === selected)?.transformable !== false;
  useEffect(() => {
    setImportDetailsOpen(false);
    setUnitScale(current?.scale ?? 1);
  }, [current?.id, current?.scale]);
  const pcbModels = usePcbModels(
    projectId,
    view.board?.pcbRevision
      ? [{ path: "board.kicad_pcb", pcbRevision: view.board.pcbRevision }]
      : [],
    panel !== "design",
  );
  const errors = [
    ...(view.alignment?.issues?.map((i) => i.message) ?? []),
    ...(view.warnings ?? []),
  ];
  const editable = loaded && !busy && !preview && explode === 0;
  const visibleParts = assemblyItems.filter((item) =>
    `${item.name} ${item.path} ${item.kind}`
      .toLowerCase()
      .includes(partFilter.trim().toLowerCase()),
  );
  useEffect(() => {
    // Reopening the board panel must not restore an overlay over the chat.
    if (!boardVisible) setExpanded(false);
  }, [boardVisible]);
  const compactImport = current?.kind === "import" && !preview;
  const addEntry = panel === "add" && !preview && !current && !showReview && !showExport;
  const rightPanel = (!!current && !preview && !compactImport) || showReview || showExport;
  const leftPanel =
    !compactImport &&
    (panel === "assembly" || panel === "generate") &&
    (!preview || panel === "generate");
  useEffect(() => {
    if (panel === "design" || !host.current) return;
    const frame = () =>
      scene.current?.setViewportInsets({
        left: leftPanel ? 320 : 24,
        right: addEntry ? 356 : rightPanel ? 320 : 24,
        top: compactImport ? 170 : 64,
        bottom: 76,
      });
    frame();
    const observer = new ResizeObserver(frame);
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [panel, leftPanel, rightPanel, addEntry, compactImport]);
  function selectModel(id: string | null) {
    setSelected(id);
    if (id) {
      setShowReview(false);
      setShowExport(false);
    }
  }
  function save(next: MechanicalItem[]) {
    const version = ++saveVersion.current;
    setSaveState("Saving…");
    const text = JSON.stringify({ version: 1, items: next });
    saveQueue.current = saveQueue.current
      .catch(() => {})
      .then(() => client.writeFile(projectId, MECHANICAL_LAYOUT_PATH, text))
      .then(() => {
        if (live.current && version === saveVersion.current) setSaveState("Saved in project");
      })
      .catch((e) => {
        if (live.current && version === saveVersion.current) {
          setError("Could not save assembly: " + message(e));
          setSaveState("Save failed");
        }
      });
  }
  function commit(next: MechanicalItem[], record = true) {
    historyScope.current = "assembly";
    if (record) {
      history.current = [...history.current.slice(-39), itemsRef.current];
      future.current = [];
    }
    itemsRef.current = next;
    setItems(next);
    setHistoryVersion((n) => n + 1);
    save(next);
  }
  function patch(id: string, change: Partial<MechanicalItem>) {
    if (id.startsWith("@fit-")) {
      const board = assemblyItems.find((item) => item.id === id);
      if (!board) return;
      if (typeof change.visible === "boolean") {
        setHiddenSharedBoards((previous) => {
          const next = new Set(previous);
          if (change.visible) next.delete(id);
          else next.add(id);
          return next;
        });
      }
      if (
        (change.position || change.rotation) &&
        assemblyBoards.find((model) => model.item.id === id)?.transformable !== false
      ) {
        historyScope.current = "enclosure";
        enclosureController.current?.transformBoard(
          id,
          change.position ?? board.position,
          change.rotation ?? board.rotation,
        );
      }
      return;
    }
    commit(itemsRef.current.map((i) => (i.id === id ? { ...i, ...change } : i)));
  }
  const transform = useRef((id: string, p: [number, number, number], r: [number, number, number]) =>
    patch(id, { position: p, rotation: r }),
  );
  transform.current = (id, p, r) => patch(id, { position: p, rotation: r });
  useEffect(() => {
    live.current = true;
    lifecycle.current = new AbortController();
    try {
      const s = new MechanicalScene(host.current!, {
        select: (id) => {
          setSelected(id);
          if (id) {
            setShowReview(false);
            setShowExport(false);
          }
        },
        transform: (...args) => transform.current(...args),
        measured: setMeasured,
        zoom: setZoom,
        orientation: setOrientation,
        error: setError,
      });
      scene.current = s;
      return () => {
        live.current = false;
        lifecycle.current.abort();
        s.dispose();
        scene.current = null;
      };
    } catch (e) {
      setError("Could not start the 3D viewer: " + message(e));
      return () => {
        live.current = false;
      };
    }
  }, []);
  useEffect(() => {
    let canceled = false;
    loadedProject.current = null;
    setLoaded(false);
    setSelected(null);
    setStepRetry(null);
    setError(null);
    setPreview(null);
    setStatus({});
    setConfirmedScales({});
    setHiddenSharedBoards(new Set());
    setItems([]);
    itemsRef.current = [];
    setSources([]);
    setSharedBoardModels([]);
    buffers.current.clear();
    history.current = [];
    future.current = [];
    historyScope.current = "assembly";
    saveVersion.current += 1;
    lastSceneModels.current = "";
    void scene.current?.setModels([], false);
    void (async () => {
      try {
        const details = await client.getProject(projectId);
        let next: MechanicalItem[] = [];
        const hasLayout = details.files.some((f) => f.path === MECHANICAL_LAYOUT_PATH);
        if (hasLayout)
          next = parseMechanicalLayout(
            await client.readFile(projectId, MECHANICAL_LAYOUT_PATH),
          ).items;
        let res: EnclosureResult = {};
        try {
          res = result(await client.callTool("cad_enclosure", { projectId, action: "status" }));
        } catch (e) {
          if (!canceled) setError("Board enclosure is unavailable: " + message(e));
        }
        if (canceled) return;
        setStatus(res);
        if (res.params)
          setForm(
            Object.fromEntries(
              Object.entries(DEFAULTS).map(([key, value]) => [key, res.params?.[key] ?? value]),
            ) as Form,
          );
        const add = (path: string, kind: MechanicalItem["kind"], name: string) => {
          if (!hasLayout && !next.some((i) => i.path === path))
            next.push(mechanicalItem(path, kind, name));
        };
        if (details.files.some((f) => f.path === "renders/board.glb"))
          add("renders/board.glb", "board", "PCB model");
        else if (res.board?.geometry) add("@board-envelope", "board", "PCB model");
        for (const [path, kind, name] of [
          [res.stl, "base", "Enclosure base"],
          [res.lidStl, "lid", "Enclosure lid"],
        ] as const)
          if (path && details.files.some((f) => f.path === path)) add(path, kind, name);
        for (const item of next)
          if (
            item.kind === "board" &&
            !details.files.some((f) => f.path === MECHANICAL_LAYOUT_PATH)
          )
            item.position[2] =
              Number(res.params?.["floorMm"] ?? 2) + Number(res.params?.["standoffMm"] ?? 3);
        itemsRef.current = next;
        setItems(next);
        setPanel((current) => (current === "design" || current === "assembly" ? current : "add"));
        setSaveState("Saved in project");
        loadedProject.current = projectId;
        setLoaded(true);
      } catch (e) {
        if (!canceled) {
          setError(message(e));
          setSaveState("Not loaded");
          setLoaded(false);
        }
      }
    })();
    return () => {
      canceled = true;
    };
  }, [client, projectId]);
  useEffect(() => {
    if (!loaded || loadedProject.current !== projectId) return;
    let canceled = false;
    void (async () => {
      try {
        const all: SceneModel[] = [];
        const missing: string[] = [];
        const outline = view.board?.geometry?.outline;
        const origin: [number, number, number] = outline
          ? [(outline.minX + outline.maxX) / 2, (outline.minY + outline.maxY) / 2, 0]
          : [0, 0, 0];
        for (const item of items) {
          if (item.kind === "board" && assemblyBoards.length) continue;
          if (preview && (item.kind === "base" || item.kind === "lid")) continue;
          if (item.kind === "board" && view.board?.pcbRevision) {
            const model = pcbModels.models["board.kicad_pcb"];
            if (model) all.push(detailedBoardSource({ item, origin }, model));
            continue;
          }
          if (item.path === "@board-envelope") {
            const board = view.board?.geometry;
            if (board) all.push({ item, board, thickness: view.board?.thicknessMm ?? 1.6, origin });
            continue;
          }
          try {
            let data = buffers.current.get(item.path);
            if (!data) {
              const blob = await client.readFileBlob(projectId, item.path);
              validateModelFile(item.path, blob.size);
              data = await blob.arrayBuffer();
              if (canceled) return;
              buffers.current.set(item.path, data);
            }
            all.push({
              item,
              data,
              ...(item.kind === "import" ? { enclosure: true, transformable: true } : { origin }),
            });
          } catch {
            missing.push(item.name);
          }
        }
        if (preview?.meshes) {
          const pose = enclosurePose(
            items.find((i) => i.kind === "board"),
            Number(preview.params?.["floorMm"] ?? 2) + Number(preview.params?.["standoffMm"] ?? 3),
          );
          all.push(
            {
              item: {
                ...mechanicalItem("@preview-base.stl", "base", "Enclosure preview"),
                ...pose,
              },
              data: new TextEncoder().encode(preview.meshes.base).buffer,
              origin,
            },
            {
              item: { ...mechanicalItem("@preview-lid.stl", "lid", "Lid preview"), ...pose },
              data: new TextEncoder().encode(preview.meshes.lid).buffer,
              origin,
            },
          );
        }
        if (!canceled) {
          if (missing.length)
            setError(
              "Could not load " +
                missing.join(", ") +
                ". Other models remain available. Reimport or remove the missing models from Assembly.",
            );
          const combined = [...all, ...assemblyBoards];
          setSources(combined);
          const modelIds = combined
            .filter((model) => !model.guide)
            .map((model) => model.item.id)
            .sort()
            .join("\n");
          await scene.current?.setModels(combined, false);
          if (!canceled && modelIds !== lastSceneModels.current) {
            lastSceneModels.current = modelIds;
            scene.current?.fit();
          }
          if (!canceled) setModelRevision((n) => n + 1);
        }
      } catch (e) {
        if (!canceled) setError("Could not load assembly: " + message(e));
      }
    })();
    return () => {
      canceled = true;
    };
  }, [
    items,
    loaded,
    preview,
    status,
    revision,
    client,
    projectId,
    pcbModels.models,
    assemblyBoards,
  ]);
  useEffect(() => {
    scene.current?.select(selected);
    scene.current?.setPlanarPlacement(selected?.startsWith("@fit-") ?? false);
  }, [selected]);
  useEffect(() => {
    scene.current?.setMode(
      editable && (mode === "measure" || currentTransformable) ? mode : "orbit",
    );
  }, [mode, editable, currentTransformable]);
  useEffect(() => {
    scene.current?.setExplode(explode);
  }, [explode]);
  useEffect(() => {
    scene.current?.setTranslucent(ghost);
  }, [ghost]);
  async function perform(label: string, action: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (e) {
      if (live.current) setError(message(e));
    } finally {
      operation.current = false;
      if (live.current) setBusy("");
    }
  }
  async function importModel(file: File) {
    await perform("Importing model…", async () => {
      const stepFile = /\.(?:step|stp)$/i.test(file.name);
      if (stepFile) validateEnclosureFile(file.name, file.size);
      else validateModelFile(file.name, file.size);
      if (itemsRef.current.length >= 100)
        throw new Error(
          "An assembly can contain up to 100 models. Remove a model before importing another.",
        );
      if (!scene.current)
        throw new Error("The 3D viewer is unavailable. Reopen the CAD tab before importing.");
      const name = file.name.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(-120),
        path = `cad/imports/${crypto.randomUUID()}-${name}`;
      if (stepFile) {
        await client.writeFile(projectId, path, file);
        if (live.current) await importStepPreview(path, file.name.slice(0, 200));
        return;
      }
      const item = mechanicalItem(path, "import", file.name.slice(0, 200)),
        data = await file.arrayBuffer();
      await scene.current?.validate({ item, data });
      if (!live.current) return;
      await client.writeFile(projectId, path, file);
      if (!live.current) return;
      buffers.current.set(path, data);
      commit([...itemsRef.current, item]);
      selectModel(item.id);
      setPanel("assembly");
      setMode("translate");
    });
  }
  async function importStepPreview(path: string, name: string) {
    setStepRetry({ path, name });
    try {
      if (itemsRef.current.length >= 100)
        throw new Error("Remove a model before importing another.");
      const response = await client.callTool("cad_fit", {
        projectId,
        action: "model_preview",
        sourcePath: path,
      });
      let previewResult = result(response);
      if (response.jobId) {
        const job = await client.waitJob(response.jobId, { signal: lifecycle.current.signal });
        if (job.status !== "done") throw new Error(job.error ?? "STEP preview did not finish.");
        previewResult = result({ result: job.result });
      }
      if (!previewResult.mesh || previewResult.format !== "stl")
        throw new Error(
          "The CAD bridge did not return a STEP preview. Check the FreeCAD connection in Advanced CAD.",
        );
      const data = decodeMesh(previewResult.mesh),
        previewPath = `${path}.preview.stl`;
      validateModelFile(previewPath, data.byteLength);
      const item = mechanicalItem(previewPath, "import", name);
      if (!scene.current) throw new Error("The 3D viewer is unavailable. Reopen CAD and retry.");
      await scene.current.validate({ item, data, enclosure: true, transformable: true });
      if (!live.current) return;
      await client.writeFile(projectId, previewPath, new Blob([data], { type: "model/stl" }));
      if (!live.current) return;
      buffers.current.set(previewPath, data);
      commit([...itemsRef.current, item]);
      selectModel(item.id);
      setPanel("assembly");
      setMode("translate");
      setStepRetry(null);
    } catch (error) {
      throw new Error(`${message(error)} Your original STEP file is preserved.`);
    }
  }
  async function previewEnclosure() {
    await perform("Building preview…", async () => {
      const next = result(
        await client.callTool("cad_enclosure", {
          projectId,
          action: "preview",
          applyToCad: false,
          ...form,
        }),
      );
      if (!next.meshes)
        throw Error(
          "The running backend does not support 3D previews. Restart the app after updating.",
        );
      if (!live.current) return;
      previewForm.current = { ...form };
      setPreview(next);
      setMode("orbit");
      setSelected(null);
      setExplode(22);
    });
  }
  async function apply() {
    await perform("Applying enclosure…", async () => {
      if (!preview?.pcbRevision || !previewForm.current) return;
      const next = result(
        await client.callTool("cad_enclosure", {
          projectId,
          action: "generate",
          applyToCad: false,
          expectedBoardRevision: preview.pcbRevision,
          ...previewForm.current,
        }),
      );
      if (!live.current) return;
      let models = itemsRef.current.filter((i) => i.kind !== "base" && i.kind !== "lid");
      for (const [path, kind, name] of [
        [next.stl, "base", "Enclosure base"],
        [next.lidStl, "lid", "Enclosure lid"],
      ] as const)
        if (path) {
          buffers.current.delete(path);
          models.push({
            ...mechanicalItem(path, kind, name),
            ...enclosurePose(
              models.find((i) => i.kind === "board"),
              Number(next.params?.["floorMm"] ?? 2) + Number(next.params?.["standoffMm"] ?? 3),
            ),
          });
        }
      setStatus(next);
      setPreview(null);
      commit(models);
      setPanel("assembly");
      setRevision((n) => n + 1);
    });
  }
  async function download(path: string) {
    await perform("Preparing download…", async () => {
      const blob = await client.readFileBlob(projectId, path);
      if (!live.current) return;
      const url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = path.split("/").at(-1)!;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    });
  }
  function undo(redo = false) {
    if (historyScope.current === "enclosure") {
      enclosureController.current?.undo(redo);
      return;
    }
    const from = redo ? future : history,
      to = redo ? history : future,
      previous = from.current.pop();
    if (previous) {
      to.current.push(itemsRef.current);
      commit(previous, false);
    }
  }
  function align(targetId?: string) {
    if (!current) return;
    const target = assemblyItems.find(
        (i) =>
          i.kind === "board" &&
          i.id !== current.id &&
          i.visible &&
          (!targetId || i.id === targetId),
      ),
      a = scene.current?.bounds(current.id),
      b = target && scene.current?.bounds(target.id);
    if (!a || !b) return;
    patch(current.id, {
      position: tuple([
        current.position[0] + (b.min.x + b.max.x - a.min.x - a.max.x) / 2,
        current.position[1] + (b.min.y + b.max.y - a.min.y - a.max.y) / 2,
        current.position[2],
      ]),
    });
  }
  function generateDetailedBoard() {
    void perform("Generating detailed PCB model…", async () => {
      const response = await client.callTool("render_glb", { projectId });
      if (response.jobId) {
        const job = await client.waitJob(response.jobId, {
          signal: lifecycle.current.signal,
        });
        if (job.status !== "done")
          throw new Error(job.error ?? "PCB model generation did not finish.");
      }
      if (!live.current) return;
      const blob = await client.readFileBlob(projectId, "renders/board.glb");
      const data = await blob.arrayBuffer();
      const board = mechanicalItem("renders/board.glb", "board", "PCB model");
      const prior = itemsRef.current.find((i) => i.kind === "board");
      board.position = prior?.position ?? [
        0,
        0,
        Number(status.params?.["floorMm"] ?? 2) + Number(status.params?.["standoffMm"] ?? 3),
      ];
      if (prior) {
        board.rotation = prior.rotation;
        board.scale = prior.scale;
        board.visible = prior.visible;
      }
      await scene.current?.validate({ item: board, data });
      if (!live.current) return;
      buffers.current.set("renders/board.glb", data);
      commit([...itemsRef.current.filter((i) => i.kind !== "board"), board]);
    });
  }
  // Read bounds after async model loading and every committed transform.
  useEffect(() => {
    const box = selected && scene.current?.bounds(selected);
    setDimensions(
      box
        ? [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z]
            .map((n) => n.toFixed(1))
            .join(" × ") + " mm"
        : null,
    );
  }, [selected, modelRevision]);
  const title = project.data?.name ?? "Project";
  const canUndo =
    historyScope.current === "enclosure" ? enclosureHistory.canUndo : !!history.current.length;
  const canRedo =
    historyScope.current === "enclosure" ? enclosureHistory.canRedo : !!future.current.length;
  const breadcrumb = panel === "design" ? enclosureContext : current?.name;
  const reviewCount = enclosureReviewCount || errors.length || (view.alignment?.stale ? 1 : 0);
  const projectSaveState =
    busy ||
    (saveState === "Saving…" || saveState === "Save failed"
      ? saveState
      : panel === "design" || sharedBoardModels.length
        ? enclosureStatus
        : saveState);
  function openAssembly() {
    setWorkspaceTab("assembly");
    setPanel("add");
    setSelected(null);
    setMode("orbit");
    setShowReview(false);
    setShowExport(false);
  }
  function openConnections() {
    setWorkspaceTab("connections");
    setPanel("design");
    setSelected(null);
    setShowReview(false);
    setShowExport(false);
    enclosureController.current?.openConnections();
  }
  function openEnclosure() {
    setWorkspaceTab("assembly");
    setPanel("design");
    setSelected(null);
    setShowReview(false);
    setShowExport(false);
    enclosureController.current?.openGenerator();
  }
  function openReview() {
    if (sharedBoardModels.length || panel === "design") {
      setPanel("design");
      enclosureController.current?.openReview();
    } else {
      setShowReview(true);
      setShowExport(false);
      setSelected(null);
    }
  }
  function openExport() {
    if (panel === "design" || sharedBoardModels.length) {
      setPanel("design");
      enclosureController.current?.openExport();
    } else {
      setShowExport(true);
      setShowReview(false);
      setSelected(null);
    }
  }
  function confirmScale() {
    if (!current || current.kind !== "import" || !editable) return;
    if (current.scale !== unitScale) patch(current.id, { scale: unitScale });
    setConfirmedScales((previous) => ({ ...previous, [current.id]: unitScale }));
  }
  return (
    <section
      className={`fd-mechanical${expanded && boardVisible ? " is-expanded" : ""}${leftPanel ? " has-left-panel" : ""}${rightPanel ? " has-right-panel" : ""}${preview ? " has-preview" : ""}${explode > 0 && !preview ? " is-exploded" : ""}`}
      data-testid="mechanical-workspace"
      data-enclosure-design={panel === "design"}
      data-add-entry={addEntry}
      data-import-selected={compactImport}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (
          advancedOpen ||
          (e.target instanceof HTMLElement &&
            e.target.closest("input, textarea, select, [contenteditable=true]"))
        )
          return;
        if (e.key === "Escape") {
          setMode("orbit");
          setSelected(null);
          setShowReview(false);
          setShowExport(false);
          e.preventDefault();
          e.stopPropagation();
        } else if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey && !e.altKey) {
          scene.current?.fit();
          e.preventDefault();
          e.stopPropagation();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && editable) {
          undo(e.shiftKey);
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = panel === "design" ? "none" : "copy";
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (panel !== "design" && editable && e.dataTransfer.files[0])
          void importModel(e.dataTransfer.files[0]);
      }}
    >
      <div className="fd-mechanical-stage" ref={host} />
      <header className="fd-mechanical-header fd-mechanical-reference-header">
        <div className="fd-mechanical-breadcrumbs">
          <span className="fd-mechanical-brand">
            <CircuitLogo width={22} height={22} viewBox="6 6 40 40" />
            <strong>fabPlane</strong>
          </span>
          <select
            aria-label="Mechanical project"
            className="fd-mechanical-project-select"
            value={projectId}
            disabled={!!busy}
            onChange={(e) => setActiveProject(e.target.value)}
          >
            {!projects.data?.some((p) => p.id === projectId) && (
              <option value={projectId}>{title}</option>
            )}
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="fd-mechanical-divider">/</span>
          <button className="fd-mechanical-breadcrumb-link" onClick={openAssembly}>
            Mechanical
          </button>
          {breadcrumb && (
            <>
              <span className="fd-mechanical-divider">/</span>
              <span className="fd-mechanical-current-context" title={breadcrumb}>
                {breadcrumb}
              </span>
            </>
          )}
        </div>
        <div className="fd-mechanical-header-actions">
          <span className="fd-mechanical-save" role="status">
            <span className="fd-mechanical-save-dot" />{" "}
            {projectSaveState === "Saved in project" ||
            projectSaveState === "Enclosure settings loaded"
              ? "Saved"
              : projectSaveState}
          </span>
          {panel !== "design" && saveState === "Save failed" && (
            <button onClick={() => save(itemsRef.current)}>Retry save</button>
          )}
          <button onClick={openExport} disabled={!!busy}>
            <Icon name="export" /> Export
          </button>
          <details className="fd-mechanical-workspace-menu">
            <summary aria-label="Workspace options">
              <Icon name="more" />
            </summary>
            <div>
              <button
                onClick={(e) => {
                  e.currentTarget.closest("details")?.removeAttribute("open");
                  openAssembly();
                }}
              >
                Add enclosure or model
              </button>
              <button
                onClick={(e) => {
                  e.currentTarget.closest("details")?.removeAttribute("open");
                  setWorkspaceTab("assembly");
                  setPanel("assembly");
                  setSelected(null);
                }}
              >
                Parts & arrangement
              </button>
              <button
                onClick={(e) => {
                  e.currentTarget.closest("details")?.removeAttribute("open");
                  openEnclosure();
                }}
              >
                Generate enclosure
              </button>
              <button
                onClick={(e) => {
                  e.currentTarget.closest("details")?.removeAttribute("open");
                  enclosureController.current?.saveDraft();
                }}
              >
                Save enclosure draft
              </button>
              <button
                onClick={(e) => {
                  e.currentTarget.closest("details")?.removeAttribute("open");
                  setAdvancedOpen(true);
                }}
              >
                Advanced CAD
              </button>
              <button
                aria-pressed={ghost}
                onClick={(e) => {
                  e.currentTarget.closest("details")?.removeAttribute("open");
                  setGhost(!ghost);
                }}
              >
                {ghost ? "Show solid surfaces" : "See through models"}
              </button>
              <button
                disabled={!sources.some((source) => source.item.kind === "lid")}
                onClick={(e) => {
                  e.currentTarget.closest("details")?.removeAttribute("open");
                  setExplode(explode ? 0 : 25);
                }}
              >
                {explode ? "Close exploded view" : "Explode lid"}
              </button>
              <button
                disabled={!editable || !canUndo}
                onClick={(e) => {
                  e.currentTarget.closest("details")?.removeAttribute("open");
                  undo();
                }}
              >
                Undo assembly edit
              </button>
              <button
                disabled={!editable || !canRedo}
                onClick={(e) => {
                  e.currentTarget.closest("details")?.removeAttribute("open");
                  undo(true);
                }}
              >
                Redo assembly edit
              </button>
              <button
                aria-pressed={expanded}
                onClick={(e) => {
                  e.currentTarget.closest("details")?.removeAttribute("open");
                  setExpanded(!expanded);
                }}
              >
                {expanded ? "Show chat" : "Focus CAD"}
              </button>
            </div>
          </details>
        </div>
      </header>
      <div className="fd-mechanical-top">
        <div
          className="fd-mechanical-segment"
          hidden={panel === "design" && workspaceTab !== "connections"}
        >
          <button
            aria-pressed={workspaceTab === "assembly"}
            disabled={!!preview || !!busy}
            onClick={openAssembly}
          >
            Assembly
          </button>
          <button
            aria-pressed={workspaceTab === "connections"}
            disabled={!!preview || !!busy}
            onClick={openConnections}
          >
            Connections
          </button>
        </div>
        <div
          className="fd-mechanical-actions fd-mechanical-reference-actions"
          hidden={panel === "design"}
        >
          <button
            className={`fd-mechanical-review${reviewCount ? " has-warnings" : ""}`}
            aria-pressed={showReview}
            onClick={openReview}
          >
            <Icon name={reviewCount ? "warning" : "checklist"} />
            Review updates
          </button>
        </div>
      </div>
      <EnclosureDesigner
        key={projectId}
        projectId={projectId}
        active={panel === "design"}
        onStatusChange={setEnclosureStatus}
        cadRuntime={cadRuntime}
        controllerRef={enclosureController}
        onAssemblyModelsChange={setSharedBoardModels}
        onContextChange={setEnclosureContext}
        onReviewCountChange={setEnclosureReviewCount}
        onConnectionsChange={onConnectionsChange}
        onHistoryChange={setEnclosureHistory}
      />
      <div
        className="fd-mechanical-viewport-tools"
        hidden={panel === "design" || addEntry || !sources.length}
      >
        <MechanicalViewCube
          orientation={orientation}
          onView={(view) => scene.current?.view(view)}
        />
        {explode > 0 && !preview && (
          <div className="fd-mechanical-edit-banner" role="status">
            <span>Exploded view · editing paused</span>
            <button onClick={() => setExplode(0)}>Return to editing</button>
          </div>
        )}
      </div>
      {addEntry && (
        <aside
          className="fd-mechanical-card fd-mechanical-add fd-mechanical-entry"
          aria-label="Add enclosure"
        >
          <div className="fd-mechanical-card-heading">
            <h2>Add enclosure</h2>
            <details className="fd-mechanical-workspace-menu">
              <summary aria-label="Add enclosure options">
                <Icon name="more" />
              </summary>
              <div>
                <button onClick={() => setPanel(null)}>Hide panel</button>
              </div>
            </details>
          </div>
          <button
            className="fd-mechanical-entry-action"
            disabled={!editable}
            onClick={() => input.current?.click()}
          >
            <span className="fd-mechanical-entry-icon">
              <MechanicalIcon name="cube" />
            </span>
            <span className="fd-mechanical-entry-label">
              <strong>Import 3D model</strong>
              <small>Use your existing case or part</small>
            </span>
            <Icon name="chevronRight" />
          </button>
          <button className="fd-mechanical-entry-action" disabled={!!busy} onClick={openEnclosure}>
            <span className="fd-mechanical-entry-icon">
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m10 3 2.5 6.5L19 12l-6.5 2.5L10 21l-2.5-6.5L1 12l6.5-2.5L10 3Z" />
                <path d="m20 2 1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z" />
              </svg>
            </span>
            <span className="fd-mechanical-entry-label">
              <strong>Generate enclosure</strong>
              <small>Start from your boards</small>
            </span>
            <Icon name="chevronRight" />
          </button>
          <footer>
            <span>STL · STEP · OBJ · GLB</span>
            <button onClick={() => setFormatsOpen(true)}>Other supported formats…</button>
          </footer>
        </aside>
      )}
      {addEntry && sources.length > 0 && (
        <button
          className="fd-mechanical-drop-hint"
          disabled={!editable}
          onClick={() => input.current?.click()}
        >
          <svg
            className="fd-drop-arrow"
            width="90"
            height="90"
            viewBox="0 0 90 90"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M8 84C8 29 36 10 78 10m-7-5 8 5-8 6"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeDasharray="4 4"
            />
          </svg>
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M7 18H5a4 4 0 0 1-.5-8A7 7 0 0 1 18 8a5 5 0 0 1 1 10h-2M12 21V12m-3 3 3-3 3 3" />
          </svg>
          <span>
            Drop a model
            <br />
            onto the canvas
          </span>
        </button>
      )}
      {panel === "assembly" && !preview && !compactImport && (
        <aside className="fd-mechanical-card fd-mechanical-left fd-mechanical-parts-panel">
          <div className="fd-mechanical-card-heading">
            <h2>Parts</h2>
            <span>
              {partFilter.trim()
                ? `${visibleParts.length} / ${assemblyItems.length}`
                : `${assemblyItems.length} ${assemblyItems.length === 1 ? "part" : "parts"}`}
            </span>
            <button aria-label="Close panel" onClick={() => setPanel(null)}>
              <Icon name="close" />
            </button>
          </div>
          <input
            className="fd-mechanical-part-search"
            type="search"
            aria-label="Find a part"
            placeholder="Find a part…"
            value={partFilter}
            onChange={(e) => setPartFilter(e.target.value)}
          />
          <div className="fd-mechanical-parts">
            {view.board?.pcbRevision && <PcbModelStatus {...pcbModels} />}
            {visibleParts.map((i) => (
              <div key={i.id} className={selected === i.id ? "is-selected" : ""}>
                <button
                  title={i.visible ? "Hide model" : "Show model"}
                  aria-label={`${i.visible ? "Hide" : "Show"} ${i.name}`}
                  disabled={!editable}
                  onClick={() => patch(i.id, { visible: !i.visible })}
                >
                  <MechanicalIcon name={i.visible ? "eye" : "eyeOff"} />
                </button>
                <button aria-pressed={selected === i.id} onClick={() => selectModel(i.id)}>
                  <strong>
                    {i.path === "@board-envelope" && view.board?.pcbRevision ? "PCB model" : i.name}
                  </strong>
                  <small>
                    {i.kind === "import"
                      ? "Imported · original preserved"
                      : i.path === "@board-envelope"
                        ? "KiCad PCB geometry"
                        : i.kind === "board"
                          ? "PCB model"
                          : "Generated enclosure"}
                  </small>
                </button>
              </div>
            ))}
            {!visibleParts.length && (
              <p className="fd-mechanical-empty-search">
                {assemblyItems.length
                  ? "No matching parts."
                  : "Import a model to start your assembly."}
                {assemblyItems.length > 0 && (
                  <button onClick={() => setPartFilter("")}>Clear search</button>
                )}
              </p>
            )}
          </div>
          <footer className="fd-mechanical-parts-actions">
            <button
              className="fd-mechanical-wide"
              disabled={!editable}
              onClick={() => input.current?.click()}
            >
              <Icon name="plus" /> Import model
            </button>
            {!sharedBoardModels.length && (
              <button
                className="fd-mechanical-wide"
                disabled={!loaded || !!busy || !!preview}
                onClick={() =>
                  view.board?.pcbRevision ? pcbModels.retry() : generateDetailedBoard()
                }
              >
                {view.board?.pcbRevision || items.some((i) => i.path === "renders/board.glb")
                  ? "Refresh PCB model"
                  : "Generate detailed PCB model"}
              </button>
            )}
            <p>Moving parts keeps original files unchanged.</p>
          </footer>
        </aside>
      )}
      {panel === "generate" && (
        <aside className="fd-mechanical-card fd-mechanical-left">
          <div className="fd-mechanical-card-heading">
            <h2>Generate enclosure</h2>
            <button aria-label="Close panel" onClick={() => setPanel(null)}>
              <Icon name="close" />
            </button>
          </div>
          <label>
            Around
            <select disabled>
              <option>Project PCB</option>
            </select>
          </label>
          {(
            [
              ["clearanceMm", "Clearance", 0, 20],
              ["wallMm", "Wall", 0.1, 20],
            ] as const
          ).map(([key, label, min, max]) => (
            <label className="fd-mechanical-field" key={key}>
              {label}
              <span>
                <input
                  aria-label={label}
                  type="number"
                  min={min}
                  max={max}
                  step="0.1"
                  value={form[key]}
                  disabled={!!preview || !!busy}
                  onChange={(e) => setForm((f) => ({ ...f, [key]: Number(e.target.value) }))}
                />
                <em>mm</em>
              </span>
            </label>
          ))}
          <details>
            <summary>More options</summary>
            {(
              [
                ["outlineOffsetMm", "Outline offset", 0, 40],
                ["headroomMm", "Headroom", 0, 40],
              ] as const
            ).map(([key, label, min, max]) => (
              <label className="fd-mechanical-field" key={key}>
                {label}
                <span>
                  <input
                    aria-label={label}
                    type="number"
                    min={min}
                    max={max}
                    step="0.1"
                    value={form[key]}
                    disabled={!!preview || !!busy}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: Number(e.target.value) }))}
                  />
                  <em>mm</em>
                </span>
              </label>
            ))}
            <label>
              Vent pattern
              <select
                value={form.ventPattern}
                disabled={!!preview || !!busy}
                onChange={(e) => setForm((f) => ({ ...f, ventPattern: e.target.value }))}
              >
                {["none", "grid", "slots", "honeycomb"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              Vent faces
              <select
                value={form.ventFaces}
                disabled={!!preview || !!busy}
                onChange={(e) => setForm((f) => ({ ...f, ventFaces: e.target.value }))}
              >
                <option value="lid">Lid</option>
                <option value="walls">Walls</option>
                <option value="both">Lid + walls</option>
              </select>
            </label>
            <label className="fd-mechanical-check">
              <input
                type="checkbox"
                checked={form.snapFit}
                disabled={!!preview || !!busy}
                onChange={(e) => setForm((f) => ({ ...f, snapFit: e.target.checked }))}
              />
              Snap-fit clips
            </label>
          </details>
          <button
            className="fd-mechanical-primary fd-mechanical-wide"
            disabled={!loaded || !!busy || !!preview || !status.board?.geometry}
            onClick={() => void previewEnclosure()}
          >
            Preview enclosure
          </button>
          <p>Review connector openings and clearances before printing.</p>
        </aside>
      )}
      {current && !preview && (
        <div
          className={`fd-mechanical-selection fd-mechanical-card${compactImport ? " fd-mechanical-import-toolbar" : ""}`}
        >
          {compactImport ? (
            <>
              <div
                className="fd-import-context-row"
                role="toolbar"
                aria-label="Selected model tools"
              >
                <span className="fd-import-context-name" title={current.name}>
                  <MechanicalIcon name="cube" />
                  <strong>{current.name}</strong>
                </span>
                <button
                  aria-pressed={mode === "translate"}
                  disabled={!editable}
                  onClick={() => setMode(mode === "translate" ? "orbit" : "translate")}
                >
                  <ImportToolIcon name="move" />
                  Move
                </button>
                <details className="fd-import-popover">
                  <summary aria-label="Align model">
                    <ImportToolIcon name="align" />
                    <span>Align</span>
                  </summary>
                  <div>
                    <label>
                      Align with
                      <select
                        aria-label="Alignment target board"
                        value={alignTarget}
                        onChange={(e) => setAlignTarget(e.target.value)}
                      >
                        <option value="">First visible board</option>
                        {assemblyItems
                          .filter((item) => item.kind === "board" && item.visible)
                          .map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <button
                      disabled={
                        !editable ||
                        !assemblyItems.some((item) => item.kind === "board" && item.visible)
                      }
                      onClick={(e) => {
                        align(alignTarget || undefined);
                        e.currentTarget.closest("details")?.removeAttribute("open");
                      }}
                    >
                      Center over board
                    </button>
                    <small>Keeps the model’s height and rotation.</small>
                  </div>
                </details>
                <button
                  aria-pressed={mode === "measure"}
                  disabled={!editable}
                  onClick={() => setMode(mode === "measure" ? "orbit" : "measure")}
                >
                  <ImportToolIcon name="measure" />
                  Measure
                </button>
                <details className="fd-import-popover fd-import-more">
                  <summary aria-label="More model actions">
                    <Icon name="more" />
                  </summary>
                  <div>
                    <button
                      disabled={!editable}
                      aria-pressed={mode === "rotate"}
                      onClick={(e) => {
                        setMode(mode === "rotate" ? "orbit" : "rotate");
                        e.currentTarget.closest("details")?.removeAttribute("open");
                      }}
                    >
                      Rotate model
                    </button>
                    <button
                      onClick={(e) => {
                        setImportDetailsOpen(!importDetailsOpen);
                        e.currentTarget.closest("details")?.removeAttribute("open");
                      }}
                    >
                      Position, rotation & scale
                    </button>
                    <button
                      disabled={!editable}
                      onClick={(e) => {
                        e.currentTarget.closest("details")?.removeAttribute("open");
                        void perform("Opening enclosure fit…", async () => {
                          const viewer = scene.current,
                            controller = enclosureController.current;
                          if (!viewer || !controller)
                            throw new Error(
                              "The enclosure workspace is still loading. Try again in a moment.",
                            );
                          const mesh = await viewer.exportModelStl(current.id);
                          await controller.useImportedCase(current, mesh);
                          if (live.current) {
                            setWorkspaceTab("assembly");
                            setPanel("design");
                            setSelected(null);
                          }
                        });
                      }}
                    >
                      Use as enclosure
                    </button>
                    <button
                      disabled={!editable}
                      onClick={(e) => {
                        patch(current.id, { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 });
                        e.currentTarget.closest("details")?.removeAttribute("open");
                      }}
                    >
                      Reset transform
                    </button>
                    <button
                      disabled={!editable}
                      className="fd-import-remove"
                      onClick={() => {
                        commit(items.filter((item) => item.id !== current.id));
                        setSelected(null);
                      }}
                    >
                      Remove from assembly
                    </button>
                    <button
                      onClick={() => {
                        setSelected(null);
                        setMode("orbit");
                      }}
                    >
                      Close selection
                    </button>
                  </div>
                </details>
              </div>
              <div className="fd-import-scale-row">
                <label>
                  Units:{" "}
                  <select
                    aria-label="Imported model units"
                    disabled={!editable || /\.glb$/i.test(current.path)}
                    title={
                      /\.glb$/i.test(current.path)
                        ? "GLB units are converted to millimetres automatically"
                        : "Choose the units used by this STL or OBJ"
                    }
                    value={unitScale}
                    onChange={(e) => setUnitScale(Number(e.target.value))}
                  >
                    <option value={1}>mm</option>
                    <option value={10}>cm</option>
                    <option value={25.4}>in</option>
                    {![1, 10, 25.4].includes(unitScale) && (
                      <option value={unitScale}>Custom ×{unitScale}</option>
                    )}
                  </select>
                </label>
                <button
                  disabled={
                    !editable ||
                    !dimensions ||
                    (confirmedScales[current.id] === unitScale && current.scale === unitScale)
                  }
                  onClick={confirmScale}
                >
                  {confirmedScales[current.id] === unitScale && current.scale === unitScale
                    ? "Scale confirmed"
                    : "Confirm scale"}
                </button>
              </div>
              {importDetailsOpen && (
                <p className="fd-import-bounds">
                  {dimensions ?? "Reading dimensions…"} · world bounds
                </p>
              )}
            </>
          ) : (
            <div className="fd-mechanical-selection-tools">
              <div className="fd-mechanical-card-heading">
                <h2 title={current.name}>{current.name}</h2>
                <button
                  aria-label="Close selection"
                  onClick={() => {
                    setSelected(null);
                    setMode("orbit");
                  }}
                >
                  <Icon name="close" />
                </button>
              </div>
              <p className="fd-mechanical-dimensions">
                {dimensions ?? "Loading dimensions…"}
                <small>World bounds · X × Y × Z</small>
              </p>
              <div className="fd-mechanical-tool-row">
                {(
                  [
                    ["translate", "Move"],
                    ["rotate", "Rotate"],
                    ["measure", "Measure"],
                  ] as const
                ).map(([m, label]) => (
                  <button
                    key={m}
                    aria-pressed={mode === m}
                    disabled={!editable || (m !== "measure" && !currentTransformable)}
                    onClick={() => setMode(mode === m ? "orbit" : m)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                className="fd-mechanical-align"
                disabled={!editable || current.kind === "board"}
                onClick={() => align()}
              >
                Center on PCB
              </button>
            </div>
          )}
          {mode !== "measure" && (!compactImport || importDetailsOpen) && (
            <details key={current.id} open>
              <summary>{compactImport ? "Position, rotation & scale" : "Transform"}</summary>
              <div className="fd-mechanical-transform">
                {(
                  [
                    ["position", "Position", "mm"],
                    ["rotation", "Rotation", "°"],
                  ] as const
                ).map(([key, label, unit]) => (
                  <fieldset key={key}>
                    <legend>
                      {label} <span>{unit}</span>
                    </legend>
                    {["X", "Y", "Z"].map((axis, index) => (
                      <label key={axis} data-axis={axis}>
                        <span>{axis}</span>
                        <TransformNumber
                          key={`${current.id}-${key}-${axis}`}
                          label={`${label} ${axis}`}
                          step={key === "rotation" ? 1 : 0.1}
                          disabled={
                            !editable ||
                            !currentTransformable ||
                            (current.id.startsWith("@fit-") && key === "rotation" && index !== 2)
                          }
                          value={Math.round(current[key][index]! * 100) / 100}
                          onCommit={(value) => {
                            patch(current.id, {
                              [key]: tuple(current[key].map((v, k) => (k === index ? value : v))),
                            });
                          }}
                        />
                      </label>
                    ))}
                  </fieldset>
                ))}
                <label className="fd-mechanical-scale">
                  <span>
                    Uniform scale <small>1 = original size</small>
                  </span>
                  <TransformNumber
                    key={`${current.id}-scale`}
                    label="Model scale"
                    min={0.001}
                    max={10000}
                    disabled={!editable || current.id.startsWith("@fit-")}
                    value={current.scale}
                    onCommit={(scale) => patch(current.id, { scale })}
                  />
                </label>
                {!current.id.startsWith("@fit-") && (
                  <div className="fd-mechanical-part-actions">
                    <button
                      disabled={!editable}
                      onClick={() =>
                        patch(current.id, { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 })
                      }
                    >
                      Reset transform
                    </button>
                    <button
                      disabled={!editable}
                      onClick={() => {
                        commit(items.filter((i) => i.id !== current.id));
                        setSelected(null);
                      }}
                    >
                      Remove from assembly
                    </button>
                  </div>
                )}
              </div>
            </details>
          )}
        </div>
      )}
      {showReview && (
        <aside className="fd-mechanical-card fd-mechanical-review-panel">
          <div className="fd-mechanical-card-heading">
            <h2>Assembly review</h2>
            <button aria-label="Close review" onClick={() => setShowReview(false)}>
              <Icon name="close" />
            </button>
          </div>
          <p>Positioning models does not run a collision or print-fit check.</p>
          {errors.length ? (
            errors.map((e, i) => (
              <p key={i} className="fd-mechanical-warning">
                <Icon name="warning" /> {e}
              </p>
            ))
          ) : (
            <p>Inspect connector openings, wall clearance and fasteners before printing.</p>
          )}
          <button
            className="fd-mechanical-wide"
            disabled={!!busy || !!preview || !status.exists}
            onClick={() =>
              void perform("Checking board alignment…", async () => {
                const next = result(
                  await client.callTool("cad_enclosure", { projectId, action: "check" }),
                );
                if (live.current) setStatus(next);
              })
            }
          >
            Check board alignment
          </button>
        </aside>
      )}
      {showExport && (
        <aside className="fd-mechanical-card fd-mechanical-review-panel">
          <div className="fd-mechanical-card-heading">
            <h2>Export enclosure</h2>
            <button aria-label="Close export" onClick={() => setShowExport(false)}>
              <Icon name="close" />
            </button>
          </div>
          <p>STL for 3D printing. STEP for editing in CAD.</p>
          <p>
            Files use generated dimensions. Assembly moves, rotation and scale do not change these
            exports.
          </p>
          {preview ? (
            <p>Apply or cancel your preview before exporting.</p>
          ) : !status.exists ? (
            <p>Generate and apply an enclosure to make export files available.</p>
          ) : null}
          {!preview &&
            (
              [
                ["Base STL", status.stl],
                ["Lid STL", status.lidStl],
                ["STEP", status.step],
              ] as const
            ).map(
              ([name, path]) =>
                path && (
                  <button
                    className="fd-mechanical-wide"
                    key={name}
                    disabled={!!busy}
                    onClick={() => void download(path)}
                  >
                    <Icon name="export" /> Download {name}
                  </button>
                ),
            )}
        </aside>
      )}
      {!sources.length && loaded && !error && !busy && (
        <div className={`fd-mechanical-empty${addEntry ? " fd-mechanical-entry-empty" : ""}`}>
          <span>
            <MechanicalIcon name="cube" />
          </span>
          {addEntry ? (
            <p>
              Drop a model
              <br />
              onto the canvas
            </p>
          ) : (
            <>
              <h2>Your mechanical workspace</h2>
              <p>Import a model or open a project with a PCB to start assembling.</p>
              <button className="fd-mechanical-primary" onClick={() => input.current?.click()}>
                Import 3D model
              </button>
            </>
          )}
        </div>
      )}
      {busy && (
        <div className="fd-mechanical-toast" role="status">
          <span className="fd-mechanical-spinner" />
          {busy}
        </div>
      )}
      {error && (
        <div className="fd-mechanical-error" role="alert">
          <span>{error}</span>
          {stepRetry && (
            <button
              disabled={!!busy}
              onClick={() =>
                void perform("Preparing STEP preview…", () =>
                  importStepPreview(stepRetry.path, stepRetry.name),
                )
              }
            >
              Retry STEP
            </button>
          )}
          <button onClick={() => setError(null)} aria-label="Dismiss error">
            <Icon name="close" />
          </button>
        </div>
      )}
      {compactImport && (
        <div className="fd-import-model-notes">
          <span>Imported mesh · original preserved</span>
          <span>
            <Icon name="warning" /> Fit not checked
          </span>
        </div>
      )}
      <div className="fd-mechanical-bottom">
        <div className="fd-mechanical-pill">
          <button title="Fit assembly (F)" onClick={() => scene.current?.fit()}>
            <MechanicalIcon name="fit" /> Fit
          </button>
          <button aria-label="Zoom out" onClick={() => scene.current?.zoom(1.2)}>
            <Icon name="minus" />
          </button>
          <span>{zoom}%</span>
          <button aria-label="Zoom in" onClick={() => scene.current?.zoom(1 / 1.2)}>
            <Icon name="plus" />
          </button>
        </div>
        <div className="fd-mechanical-pill fd-mechanical-display">
          <label>
            Explode
            <input
              aria-label="Explode lid"
              type="range"
              disabled={!sources.some((s) => s.item.kind === "lid")}
              min="0"
              max="60"
              value={explode}
              onChange={(e) => setExplode(Number(e.target.value))}
            />
          </label>
          <button aria-pressed={ghost} onClick={() => setGhost(!ghost)}>
            See through
          </button>
        </div>
        <div className="fd-mechanical-pill">
          <button
            title="Undo assembly edit (Ctrl/Cmd+Z)"
            aria-label="Undo assembly edit"
            disabled={!editable || !canUndo}
            onClick={() => undo()}
          >
            <MechanicalIcon name="undo" />
          </button>
          <button
            title="Redo assembly edit (Ctrl/Cmd+Shift+Z)"
            aria-label="Redo assembly edit"
            disabled={!editable || !canRedo}
            onClick={() => undo(true)}
          >
            <MechanicalIcon name="redo" />
          </button>
          <button
            disabled={!!busy}
            onClick={() => {
              setMode("orbit");
              scene.current?.view("iso");
              scene.current?.fit();
            }}
          >
            Reset view
          </button>
        </div>
      </div>
      <p className="fd-mechanical-help">
        {preview
          ? "Preview only · Apply to save the enclosure or Cancel to return"
          : mode === "measure"
            ? measured === null
              ? "Click two points on the model to measure in millimetres."
              : `Distance: ${measured.toFixed(2)} mm · click to measure again`
            : explode > 0
              ? "Exploded view · close the lid to move or rotate parts"
              : "Drag to orbit · scroll to zoom · right-drag to pan · F fit · Esc exit tool"}
      </p>
      {!view.board?.pcbRevision && items.some((i) => i.path === "@board-envelope") && (
        <div className="fd-mechanical-envelope-note">
          <span>PCB envelope · estimated parts</span>
          <button disabled={!loaded || !!busy || !!preview} onClick={generateDetailedBoard}>
            Load detailed PCB
          </button>
        </div>
      )}
      {preview && (
        <div className="fd-mechanical-preview-bar">
          <span>Preview · not applied</span>
          <button
            disabled={!!busy}
            onClick={() => {
              setPreview(null);
              setExplode(0);
            }}
          >
            Cancel
          </button>
          <button className="fd-mechanical-primary" disabled={!!busy} onClick={() => void apply()}>
            Apply enclosure
          </button>
        </div>
      )}
      <input
        ref={input}
        type="file"
        hidden
        disabled={!editable}
        accept=".stl,.step,.stp,.obj,.glb"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void importModel(file);
        }}
      />
      {formatsOpen && (
        <Dialog
          open
          title="Supported 3D files"
          className="w-[440px]"
          onClose={() => setFormatsOpen(false)}
        >
          <div className="fd-mechanical-format-help">
            <p>
              <strong>STL · OBJ</strong>
              <span>Import a mesh. Choose its source units and confirm the scale.</span>
            </p>
            <p>
              <strong>STEP · STP</strong>
              <span>
                Uses the connected FreeCAD bridge to create a preview. The original CAD file stays
                unchanged.
              </span>
            </p>
            <p>
              <strong>GLB</strong>
              <span>
                Import a self-contained 3D model. Standard GLB units are converted to millimetres.
              </span>
            </p>
            <small>Up to 50 MiB per file. Use Move, Align or Measure after importing.</small>
            <button
              onClick={() => {
                setFormatsOpen(false);
                setAdvancedOpen(true);
              }}
            >
              Open CAD setup
            </button>
          </div>
        </Dialog>
      )}
      {advancedOpen && (
        <Dialog
          open
          title="Advanced CAD"
          className="w-[1200px]"
          onClose={() => setAdvancedOpen(false)}
        >
          <div className="fd-mechanical-advanced">{advanced}</div>
        </Dialog>
      )}
    </section>
  );
}
