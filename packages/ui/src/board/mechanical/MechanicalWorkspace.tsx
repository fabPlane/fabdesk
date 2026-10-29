import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  useCoreClient,
  useProject,
  mechanicalItem,
  enclosurePose,
  parseMechanicalLayout,
  validateModelFile,
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
import { MechanicalIcon } from "./MechanicalIcon";
import "./mechanical.css";

type EnclosureResult = {
  exists?: boolean;
  pcbRevision?: string;
  previewOnly?: boolean;
  params?: Record<string, number | string | boolean>;
  board?: { geometry?: BoardGeometry; thicknessMm?: number };
  features?: { geometry?: BoardGeometry; thicknessMm?: number };
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
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
}: {
  projectId: string;
  advanced: ReactNode;
}) {
  const client = useCoreClient(),
    project = useProject(projectId);
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
  const [panel, setPanel] = useState<"add" | "generate" | "assembly" | null>("add"),
    [advancedOpen, setAdvancedOpen] = useState(false);
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem("fd:mechanical:focus") !== "false";
    } catch {
      return true;
    }
  });
  const [showExport, setShowExport] = useState(false);
  const [modelRevision, setModelRevision] = useState(0);
  const [dimensions, setDimensions] = useState<string | null>(null);
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
  const current = items.find((i) => i.id === selected),
    view = preview ?? status;
  const errors = [
    ...(view.alignment?.issues?.map((i) => i.message) ?? []),
    ...(view.warnings ?? []),
  ];
  const editable = loaded && !busy && !preview && explode === 0;
  useEffect(() => {
    try {
      localStorage.setItem("fd:mechanical:focus", String(expanded));
    } catch {
      /* Storage may be unavailable. */
    }
  }, [expanded]);
  const rightPanel = (!!current && !preview) || showReview || showExport;
  const leftPanel = panel !== null && (!preview || panel === "generate");
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
        else if (res.board?.geometry) add("@board-envelope", "board", "PCB envelope");
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
        setSaveState("Saved in project");
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
    if (!loaded) return;
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
          if (preview && (item.kind === "base" || item.kind === "lid")) continue;
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
            all.push({ item, data, ...(item.kind !== "import" ? { origin } : {}) });
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
          setSources(all);
          await scene.current?.setModels(all);
          if (!canceled) setModelRevision((n) => n + 1);
        }
      } catch (e) {
        if (!canceled) setError("Could not load assembly: " + message(e));
      }
    })();
    return () => {
      canceled = true;
    };
  }, [items, loaded, preview, status, revision, client, projectId]);
  useEffect(() => {
    scene.current?.select(selected);
  }, [selected]);
  useEffect(() => {
    scene.current?.setMode(editable ? mode : "orbit");
  }, [mode, editable]);
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
      validateModelFile(file.name, file.size);
      if (itemsRef.current.length >= 100)
        throw new Error(
          "An assembly can contain up to 100 models. Remove a model before importing another.",
        );
      if (!scene.current)
        throw new Error("The 3D viewer is unavailable. Reopen the CAD tab before importing.");
      const name = file.name.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(-120),
        path = `cad/imports/${crypto.randomUUID()}-${name}`,
        item = mechanicalItem(path, "import", file.name.slice(0, 200)),
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
    const from = redo ? future : history,
      to = redo ? history : future,
      previous = from.current.pop();
    if (previous) {
      to.current.push(itemsRef.current);
      commit(previous, false);
    }
  }
  function align() {
    if (!current) return;
    const target = items.find((i) => i.kind === "board" && i.id !== current.id),
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
  return (
    <section
      className={`fd-mechanical${expanded ? " is-expanded" : ""}${leftPanel ? " has-left-panel" : ""}${rightPanel ? " has-right-panel" : ""}${preview ? " has-preview" : ""}${explode > 0 && !preview ? " is-exploded" : ""}`}
      data-testid="mechanical-workspace"
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
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (editable && e.dataTransfer.files[0]) void importModel(e.dataTransfer.files[0]);
      }}
    >
      <div className="fd-mechanical-stage" ref={host} />
      <header className="fd-mechanical-header">
        <div>
          <span className="fd-mechanical-mark">
            <MechanicalIcon name="cube" />
          </span>
          <strong>Mechanical</strong>
          <span className="fd-mechanical-divider">/</span>
          <span>{current?.name ?? title}</span>
        </div>
        <div>
          <span className="fd-mechanical-save" role="status">
            ● {saveState}
          </span>
          {saveState === "Save failed" && (
            <button onClick={() => save(itemsRef.current)}>Retry save</button>
          )}
          <button onClick={() => setAdvancedOpen(true)}>Advanced CAD</button>
          <button
            title={expanded ? "Show chat beside CAD" : "Give CAD the full workspace"}
            aria-label={expanded ? "Show chat" : "Focus CAD"}
            onClick={() => setExpanded(!expanded)}
          >
            <Icon name="panel" /> {expanded ? "Show chat" : "Focus CAD"}
          </button>
        </div>
      </header>
      <div className="fd-mechanical-top">
        <div className="fd-mechanical-segment">
          {(["add", "assembly", "generate"] as const).map((p) => (
            <button
              key={p}
              aria-pressed={panel === p}
              disabled={!!preview || !!busy}
              onClick={() => {
                setPanel(p);
                setSelected(null);
                setShowExport(false);
                setShowReview(false);
                setMode("orbit");
              }}
            >
              {p === "assembly" ? "2 · Arrange" : p === "add" ? "1 · Add" : "3 · Enclosure"}
            </button>
          ))}
        </div>
        <div className="fd-mechanical-actions">
          <button
            className={`fd-mechanical-review${errors.length || view.alignment?.stale ? " has-warnings" : ""}`}
            aria-pressed={showReview}
            onClick={() => {
              setShowReview(!showReview);
              setShowExport(false);
              setSelected(null);
            }}
          >
            <Icon name={errors.length || view.alignment?.stale ? "warning" : "checklist"} />
            {errors.length || view.alignment?.stale ? `Review · ${errors.length || 1}` : "Review"}
          </button>
          <button
            className="fd-mechanical-export"
            aria-pressed={showExport}
            onClick={() => {
              setShowExport(!showExport);
              setShowReview(false);
              setSelected(null);
            }}
          >
            <Icon name="export" /> 4 · Export
          </button>
        </div>
      </div>
      <div className="fd-mechanical-viewport-tools">
        <nav className="fd-mechanical-views" aria-label="Camera views">
          <svg
            className="fd-mechanical-cube"
            viewBox="0 0 80 76"
            width="72"
            height="68"
            aria-label="Orientation cube"
          >
            {(
              [
                ["top", "M40 3 75 21 40 39 5 21Z", 40, 24, "Top"],
                ["front", "M5 21 40 39 40 73 5 55Z", 22, 48, "Front"],
                ["right", "M40 39 75 21 75 55 40 73Z", 57, 48, "Right"],
              ] as const
            ).map(([view, d, x, y, label]) => (
              <g
                key={view}
                role="button"
                tabIndex={0}
                aria-label={`${label} view`}
                onClick={() => scene.current?.view(view)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    scene.current?.view(view);
                  }
                }}
              >
                <path d={d} />
                <text x={x} y={y} textAnchor="middle">
                  {label}
                </text>
              </g>
            ))}
          </svg>
          <button title="Isometric view" onClick={() => scene.current?.view("iso")}>
            3D
          </button>
        </nav>
        {explode > 0 && !preview && (
          <div className="fd-mechanical-edit-banner" role="status">
            <span>Exploded view · editing paused</span>
            <button onClick={() => setExplode(0)}>Return to editing</button>
          </div>
        )}
      </div>
      {panel === "add" && !preview && (
        <aside className="fd-mechanical-card fd-mechanical-add">
          <div className="fd-mechanical-card-heading">
            <h2>Add to your assembly</h2>
            <button aria-label="Close panel" onClick={() => setPanel(null)}>
              <Icon name="close" />
            </button>
          </div>
          <button
            className="fd-mechanical-choice"
            disabled={!editable}
            onClick={() => input.current?.click()}
          >
            <MechanicalIcon name="cube" />
            <div>
              <strong>Import 3D model</strong>
              <small>Bring in an existing case or part</small>
            </div>
            <Icon name="chevronRight" />
          </button>
          <button
            className="fd-mechanical-choice"
            disabled={!!busy}
            onClick={() => setPanel("generate")}
          >
            <Icon name="plus" />
            <div>
              <strong>Generate enclosure</strong>
              <small>Build a case around your PCB</small>
            </div>
            <Icon name="chevronRight" />
          </button>
          <footer>
            Drop STL, OBJ or GLB onto the canvas.
            <br />
            STEP and native editing:{" "}
            <button onClick={() => setAdvancedOpen(true)}>Advanced CAD</button>
          </footer>
        </aside>
      )}
      {panel === "assembly" && !preview && (
        <aside className="fd-mechanical-card fd-mechanical-left">
          <div className="fd-mechanical-card-heading">
            <h2>Assembly</h2>
            <span>
              {items.length} {items.length === 1 ? "part" : "parts"}
            </span>
            <button aria-label="Close panel" onClick={() => setPanel(null)}>
              <Icon name="close" />
            </button>
          </div>
          <div className="fd-mechanical-parts">
            {items.map((i) => (
              <div key={i.id} className={selected === i.id ? "is-selected" : ""}>
                <button
                  title={i.visible ? "Hide model" : "Show model"}
                  aria-label={`${i.visible ? "Hide" : "Show"} ${i.name}`}
                  disabled={!editable}
                  onClick={() => patch(i.id, { visible: !i.visible })}
                >
                  <MechanicalIcon name={i.visible ? "eye" : "eyeOff"} />
                </button>
                <button onClick={() => selectModel(i.id)}>
                  <strong>{i.name}</strong>
                  <small>
                    {i.kind === "import"
                      ? "Imported · original preserved"
                      : i.path === "@board-envelope"
                        ? "Board envelope · estimated parts"
                        : i.kind === "board"
                          ? "PCB model"
                          : "Generated enclosure"}
                  </small>
                </button>
              </div>
            ))}
          </div>
          <button
            className="fd-mechanical-wide"
            disabled={!editable}
            onClick={() => input.current?.click()}
          >
            <Icon name="plus" /> Import model
          </button>
          {
            <button
              className="fd-mechanical-wide"
              disabled={!loaded || !!busy || !!preview}
              onClick={() => generateDetailedBoard()}
            >
              {items.some((i) => i.path === "renders/board.glb")
                ? "Refresh PCB model"
                : "Generate detailed PCB model"}
            </button>
          }
          <p>Assembly positions are saved separately. PCB and imported originals stay unchanged.</p>
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
        <div className="fd-mechanical-selection fd-mechanical-card">
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
                disabled={!editable}
                onClick={() => setMode(mode === m ? "orbit" : m)}
              >
                {label}
              </button>
            ))}
            <button disabled={!editable || current.kind === "board"} onClick={align}>
              Center on PCB
            </button>
          </div>
          {mode !== "measure" && (
            <details open>
              <summary>Position, rotation & scale · mm</summary>
              <div className="fd-mechanical-transform">
                {(
                  [
                    ["position", "Position", "mm"],
                    ["rotation", "Rotation", "°"],
                  ] as const
                ).map(([key, label, unit]) => (
                  <fieldset key={key}>
                    <legend>{label}</legend>
                    {["X", "Y", "Z"].map((axis, index) => (
                      <label key={axis}>
                        {axis}
                        <TransformNumber
                          key={`${current.id}-${key}-${axis}`}
                          label={`${label} ${axis}`}
                          step={key === "rotation" ? 1 : 0.1}
                          disabled={!editable}
                          value={Math.round(current[key][index]! * 100) / 100}
                          onCommit={(value) => {
                            patch(current.id, {
                              [key]: tuple(current[key].map((v, k) => (k === index ? value : v))),
                            });
                          }}
                        />
                        <small>{unit}</small>
                      </label>
                    ))}
                  </fieldset>
                ))}
                <label>
                  Scale
                  <TransformNumber
                    key={`${current.id}-scale`}
                    label="Model scale"
                    min={0.001}
                    max={10000}
                    disabled={!editable}
                    value={current.scale}
                    onCommit={(scale) => patch(current.id, { scale })}
                  />
                </label>
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
        <div className="fd-mechanical-empty">
          <span>
            <MechanicalIcon name="cube" />
          </span>
          <h2>Your mechanical workspace</h2>
          <p>Import a model or open a project with a PCB to start assembling.</p>
          <button className="fd-mechanical-primary" onClick={() => input.current?.click()}>
            Import 3D model
          </button>
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
          <button onClick={() => setError(null)} aria-label="Dismiss error">
            <Icon name="close" />
          </button>
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
            disabled={!editable || !history.current.length}
            onClick={() => undo()}
          >
            <MechanicalIcon name="undo" />
          </button>
          <button
            title="Redo assembly edit (Ctrl/Cmd+Shift+Z)"
            aria-label="Redo assembly edit"
            disabled={!editable || !future.current.length}
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
      {items.some((i) => i.path === "@board-envelope") && (
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
        accept=".stl,.obj,.glb"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void importModel(file);
        }}
      />
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
