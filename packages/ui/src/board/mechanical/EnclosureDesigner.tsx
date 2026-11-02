import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  MechanicalDesignSchema,
  portEnvelopes,
  cableAssessments,
  type MechanicalDesign,
  type MechanicalFitReport,
  type MechanicalFitIssue,
  type CadRuntimeState,
} from "@fabdesk/protocol";
import {
  useCoreClient,
  defaultEnclosureDesign,
  enclosureSourceBoards,
  selectEnclosureBoards,
  prepareEnclosurePreview,
  resizeEnclosureToFit,
  type EnclosureLayoutGoal,
  decodeMesh,
  mechanicalItem,
  enclosureErrorMessage,
  enclosureFileLabel,
  enclosureBoardPose,
  enclosureBoardPlacement,
  centerEnclosureBoard,
  editEnclosureBoardPose,
  EnclosureHistory,
  sameEnclosureDesign,
  planEnclosurePcbEdit,
  EnclosureRecoveryStore,
  enclosureRecoveryKey,
  validateEnclosureFile,
  type EnclosureRecovery,
  type EnclosureBoardSummary,
  mountingCandidates,
  mountAtHole,
  alignEnclosureMounts,
  linkEnclosureMounts,
  type LayoutBoard,
  nativeEnclosureClearanceIssues,
} from "@fabdesk/client-core";
import { MechanicalScene, type SceneModel, type BoardGeometry } from "./MechanicalScene";
import { EnclosureFitReview } from "./EnclosureFitReview";
import { MechanicalIcon } from "./MechanicalIcon";
import { detailedBoardSource, usePcbModels } from "./usePcbModels";
import { NumberField } from "./EnclosureNumberField";
import { EnclosureLayoutPanel, type LayoutChoice } from "./EnclosureLayoutPanel";
import { EnclosureBoardPicker } from "./EnclosureBoardPicker";
import { EnclosureBoardDimensions } from "./EnclosureBoardDimensions";
import { EnclosureHardwarePanel } from "./EnclosureHardwarePanel";
import { PcbModelStatus } from "./PcbModelStatus";

type Result = {
  design?: MechanicalDesign | null;
  designRevision?: string | null;
  board?: EnclosureBoardSummary | null;
  capabilities?: { pcb: boolean; cad: boolean };
  revision?: string;
  sourceRevision?: string | null;
  report?: MechanicalFitReport;
  meshes?: { base: string; lid: string | null };
  archive?: string;
  stl?: string;
  lidStl?: string | null;
  boards?: Array<{
    placement: MechanicalDesign["boards"][number];
    features: EnclosureBoardSummary;
  }>;
};
const unpack = (v: unknown) => {
  const r = v as { json?: Result; result?: { json?: Result }; isError?: boolean };
  if (r.isError) throw new Error("The operation was rejected. Reload the project and try again.");
  return r.json ?? r.result?.json ?? {};
};
const steps = ["PCB", "Start", "Review"] as const;
const stepLabels = { PCB: "Boards", Start: "Case", Review: "Preview" };
type Step = (typeof steps)[number];
/** Guided enclosure workflow; all preview coordinates are in the saved PCB frame, in mm. */
export function EnclosureDesigner({
  projectId,
  active = true,
  onStatusChange,
  cadRuntime = null,
}: {
  projectId: string;
  active?: boolean;
  onStatusChange?: (status: string) => void;
  cadRuntime?: CadRuntimeState | null;
}) {
  const client = useCoreClient();
  const [layoutChoice, setLayoutChoice] = useState<EnclosureLayoutGoal | "keep">("compact");
  const [caseDetails, setCaseDetails] = useState(false);
  const [layoutDetails, setLayoutDetails] = useState(false);
  const [manualPlacement, setManualPlacement] = useState(false);
  const [customSize, setCustomSize] = useState(false);
  const caseSettings = useRef<HTMLDetailsElement>(null);
  const layoutSettings = useRef<HTMLDetailsElement>(null);
  const [layoutProposals, setLayoutProposals] = useState<LayoutChoice[] | null>(null);
  const cancelLayout = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelLayout.current?.(), [projectId]);
  async function compareLayouts(
    value: MechanicalDesign,
    boards: LayoutBoard[],
    goal?: EnclosureLayoutGoal,
  ) {
    cancelLayout.current?.();
    const worker = new Worker(new URL("./enclosure-layout.worker.ts", import.meta.url), {
      type: "module",
    });
    const result = await new Promise<LayoutChoice[]>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        worker.terminate();
        cancelLayout.current = null;
      };
      const timer = setTimeout(() => {
        finish();
        reject(
          new Error("Layout search took too long. Try fewer boards or fewer cable constraints."),
        );
      }, 30000);
      cancelLayout.current = () => {
        finish();
        reject(new Error("Layout comparison cancelled."));
      };
      worker.onmessage = (event: MessageEvent<LayoutChoice[]>) => {
        finish();
        resolve(event.data);
      };
      worker.onerror = () => {
        finish();
        reject(new Error("Layout search could not start. Reload the panel and try again."));
      };
      try {
        worker.postMessage({ design: value, boards, ...(goal ? { goal } : {}) });
      } catch (error) {
        finish();
        reject(error);
      }
    });
    if (mounted.current && !goal) setLayoutProposals(result);
    return result;
  }
  const [showPlugs, setShowPlugs] = useState(false);
  const [design, setDesign] = useState<MechanicalDesign | null>(null),
    [board, setBoard] = useState<EnclosureBoardSummary | null>(null);
  const [step, setStep] = useState<Step>("PCB"),
    [files, setFiles] = useState<string[]>([]);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false),
    [preview, setPreview] = useState<Result | null>(null),
    [baseReport, setReport] = useState<MechanicalFitReport | null>(null);
  const [pendingRecovery, setPendingRecovery] = useState<EnclosureRecovery | null>(null);
  const [recoveryWarning, setRecoveryWarning] = useState("");
  const recoveryStore = useRef<EnclosureRecoveryStore | null>(null);
  const [archive, setArchive] = useState<string | null>(null),
    [component, setComponent] = useState(""),
    [move, setMove] = useState({ x: 0, y: 0, rotation: 0 });
  useEffect(() => {
    onStatusChange?.(
      busy ||
        (pendingRecovery
          ? "Local draft available"
          : error
            ? "Enclosure needs attention"
            : dirty
              ? "Unsaved enclosure changes"
              : preview
                ? "Enclosure preview"
                : "Enclosure settings loaded"),
    );
  }, [busy, dirty, preview, error, pendingRecovery, onStatusChange]);
  const [hole, setHole] = useState({ x: 0, y: 0, diameter: 3 }),
    [editReview, setEditReview] = useState<"outline" | "move" | "hole" | null>(null);
  const [pcbEditMode, setPcbEditMode] = useState<"outline" | "move" | "hole">("outline");
  const revision = useRef<string | null>(null),
    scene = useRef<MechanicalScene | null>(null),
    host = useRef<HTMLDivElement>(null);
  const mounted = useRef(true),
    running = useRef(false),
    importInput = useRef<HTMLInputElement>(null);
  const [modelSources, setModelSources] = useState<SceneModel[]>([]);
  const [fitBoards, setFitBoards] = useState<Result["boards"]>(undefined);
  const pcbModels = usePcbModels(
    projectId,
    (design?.boards ?? []).flatMap((placement) => {
      const features =
        (preview?.boards ?? fitBoards)?.find((b) => b.placement.path === placement.path)
          ?.features ?? (placement.path === "board.kicad_pcb" ? board : null);
      return features ? [{ path: placement.path, pcbRevision: features.pcbRevision }] : [];
    }),
    active,
  );
  const report = useMemo<MechanicalFitReport | null>(() => {
    if (!baseReport || !design) return baseReport;
    const extra = nativeEnclosureClearanceIssues(
      design,
      mountingBoards().map((b) => ({
        ...b,
        ...(pcbModels.models[b.placement.path]?.pcbRevision === b.features.pcbRevision &&
        pcbModels.models[b.placement.path]?.bounds
          ? { modelBounds: pcbModels.models[b.placement.path]!.bounds! }
          : {}),
      })),
    );
    return {
      ...baseReport,
      status: extra.length ? "blocked" : baseReport.status,
      issues: [...extra, ...baseReport.issues],
    };
  }, [baseReport, design, pcbModels.models, fitBoards, preview, board]);
  const renderedSources = useMemo<SceneModel[]>(
    () => [
      ...modelSources.flatMap((source) => {
        if (!source.board) return [source];
        const model = pcbModels.models[source.item.id.slice(5)];
        if (model) return [detailedBoardSource(source, model)];
        const { board: geometry, ...reference } = source;
        return [
          {
            ...reference,
            item: { ...source.item, name: "PCB bounds · detailed model unavailable" },
            volume: {
              x: geometry.outline.minX,
              y: geometry.outline.minY,
              z: 0,
              width: geometry.outline.maxX - geometry.outline.minX,
              depth: geometry.outline.maxY - geometry.outline.minY,
              height: source.thickness ?? 1.6,
            },
          },
        ];
      }),
      ...(showPlugs && design
        ? portEnvelopes(design, mountingBoards()).flatMap((p) =>
            p.plug
              ? [
                  {
                    item: mechanicalItem(
                      `@plug-${p.boardPath}-${p.ref}`,
                      "import",
                      `${p.ref} plug envelope`,
                    ),
                    volume: p.plug,
                    volumeColor: 0x64cbd2,
                    selectable: false,
                    origin: [0, 0, 0] as [number, number, number],
                  },
                ]
              : [],
          )
        : []),
      ...(showPlugs && design
        ? cableAssessments(design, mountingBoards(), true).flatMap((c) => {
            const points = c.route?.route?.points ?? (c.a && c.b ? [c.a, c.b] : []);
            return points.slice(1).map((end, index) => {
              const start = points[index]!;
              return {
                item: mechanicalItem(
                  `@cable-${c.id}-${index}`,
                  "import",
                  c.route?.route ? "Reserved cable corridor" : "Cable direct-distance guide",
                ),
                guide: {
                  from: [start.x, start.y, start.z] as [number, number, number],
                  to: [end.x, end.y, end.z] as [number, number, number],
                  color: c.reachable ? 0x64cbd2 : 0xf16c6c,
                },
                selectable: false,
                origin: [0, 0, 0] as [number, number, number],
              };
            });
          })
        : []),
    ],
    [modelSources, pcbModels.models, showPlugs, design, fitBoards, preview, board],
  );
  const [fitState, setFitState] = useState(""),
    [fitError, setFitError] = useState("");
  const [showRisks, setShowRisks] = useState(true),
    [showSpace, setShowSpace] = useState(true);
  const [focusedIssue, setFocusedIssue] = useState<MechanicalFitIssue | null>(null);
  const [selectedBoard, setSelectedBoard] = useState<string | null>(null);
  const [placementMode, setPlacementMode] = useState<"orbit" | "translate" | "rotate">("orbit");
  const [caseVisible, setCaseVisible] = useState(true);
  const [controlsExpanded, setControlsExpanded] = useState(true);
  const sceneToolsId = useId();
  const history = useRef(new EnclosureHistory());
  const savedDesign = useRef<MechanicalDesign | null>(null);
  const framed = useRef(false);
  useEffect(() => {
    if (!host.current) return;
    let compact: boolean | undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || !entry.contentRect.width) return;
      const next = entry.contentRect.width < 1290;
      if (next !== compact) setControlsExpanded(!next);
      compact = next;
    });
    observer.observe(host.current.parentElement!);
    return () => observer.disconnect();
  }, []);
  const placementHandlers = useRef({
    select: (_id: string | null) => {},
    transform: (
      _id: string,
      _position: [number, number, number],
      _rotation: [number, number, number],
    ) => {},
  });
  function featuresFor(path: string) {
    return (
      (preview?.boards ?? fitBoards)?.find((b) => b.placement.path === path)?.features ??
      (path === "board.kicad_pcb" ? board : null)
    );
  }
  function mountingBoards(next = design) {
    return (next?.boards ?? []).flatMap((placement) => {
      const features = featuresFor(placement.path);
      return features ? [{ placement, features }] : [];
    });
  }
  useEffect(() => {
    scene.current?.setMountingHoles(
      step === "Start" && caseDetails && design
        ? mountingBoards().flatMap((b) =>
            mountingCandidates(b.features).map((hole) => {
              const m = mountAtHole(b, hole, design.space.floor);
              return {
                x: m.x,
                y: m.y,
                z: b.placement.z + b.features.thicknessMm + 0.05,
                diameter: hole.diameterMm,
                linked: design.mounts.some((post) => Math.hypot(post.x - m.x, post.y - m.y) < 0.05),
              };
            }),
          )
        : [],
    );
  }, [step, caseDetails, design, fitBoards, board, preview]);
  function selectBoard(path: string | null) {
    if (busy || pendingRecovery) return;
    setSelectedBoard(path);
    if (!path) setPlacementMode("orbit");
    setFocusedIssue(null);
  }
  function changePlacement(next: MechanicalDesign["boards"][number]) {
    if (!design) return;
    const old = design.boards.find((b) => b.path === next.path);
    if (!old) return;
    if (old.locked) {
      setNotice("Unlock this board before changing its position.");
      return;
    }
    const moved = {
      ...design,
      boards: design.boards.map((b) => (b.path === next.path ? next : b)),
    };
    edit(alignEnclosureMounts(moved, mountingBoards(moved)), "Position board");
  }
  function restoreHistory(redo = false) {
    if (!design || busy || pendingRecovery) return;
    const label = redo ? history.current.redoLabel : history.current.undoLabel;
    const next = redo ? history.current.redo() : history.current.undo();
    if (!next) return;
    applyDraft(next);
    setNotice(`${redo ? "Redid" : "Undid"}: ${label}`);
  }
  placementHandlers.current = {
    select: (id) => selectBoard(id?.startsWith("@fit-") ? id.slice(5) : null),
    transform: (id, position, rotation) => {
      if (busy || pendingRecovery || !design) return;
      const path = id.startsWith("@fit-") ? id.slice(5) : "";
      const current = design.boards.find((b) => b.path === path),
        features = featuresFor(path);
      if (current && features)
        changePlacement(enclosureBoardPlacement(current, features.outline, position, rotation[2]));
    },
  };
  useEffect(() => {
    framed.current = false;
  }, [projectId, design?.source?.path, design?.mode]);
  useEffect(() => {
    scene.current?.select(selectedBoard ? `@fit-${selectedBoard}` : null);
    scene.current?.setMode(
      busy || pendingRecovery || design?.boards.find((b) => b.path === selectedBoard)?.locked
        ? "orbit"
        : placementMode,
    );
  }, [selectedBoard, placementMode, busy, pendingRecovery, renderedSources, design]);
  useEffect(() => {
    scene.current?.setCaseVisible(caseVisible);
  }, [caseVisible]);
  const sourceBuffers = useRef(new Map<string, ArrayBuffer>());
  const boardGeometries = useRef(new Map<string, BoardGeometry>());
  function geometryFor(path: string, features: EnclosureBoardSummary): BoardGeometry {
    const key = `${path}:${features.pcbRevision}`;
    const cached = boardGeometries.current.get(key);
    if (cached) return cached;
    const geometry: BoardGeometry = {
      outline: features.outline,
      holes: features.holes,
      parts: features.components ?? [],
      connectors: features.connectors ?? [],
    };
    boardGeometries.current.set(key, geometry);
    while (boardGeometries.current.size > 20)
      boardGeometries.current.delete(boardGeometries.current.keys().next().value!);
    return geometry;
  }
  const sourceRevisions = useRef(new Map<string, string>());
  const [sourceVersion, setSourceVersion] = useState(0);
  function acceptSourceRevision(result: Result) {
    const path = design?.source?.path;
    if (!path || !result.sourceRevision) return;
    const prior = sourceRevisions.current.get(path);
    sourceRevisions.current.set(path, result.sourceRevision);
    if (prior && prior !== result.sourceRevision) {
      sourceBuffers.current.delete(path);
      framed.current = false;
      setSourceVersion((v) => v + 1);
    }
  }
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [step, error]);
  useEffect(() => setNotice(""), [step]);
  const [capabilities, setCapabilities] = useState({ pcb: false, cad: false });
  const [openLid, setOpenLid] = useState(true),
    [transparent, setTransparent] = useState(false);
  useEffect(() => {
    scene.current?.setExplode(openLid && preview?.meshes?.lid ? 25 : 0, false);
  }, [openLid, preview?.meshes?.lid]);
  useEffect(() => {
    scene.current?.setTranslucent(transparent);
  }, [transparent, renderedSources]);
  async function call(action: string, extra: Record<string, unknown> = {}) {
    return unpack(await client.callTool("cad_fit", { projectId, action, ...extra }));
  }
  // Debounce edits; old responses never paint a newer design or replace a preview's report.
  useEffect(() => {
    if (!active || !design || preview || busy) return;
    const parsed = MechanicalDesignSchema.safeParse(design);
    setFocusedIssue(null);
    setReport(null);
    setFitError("");
    if (!parsed.success) {
      setFitState("Complete the dimensions to check fit");
      return;
    }
    let cancelled = false;
    setFitState("Checking fit…");
    const timer = setTimeout(() => {
      void call("check", { design: parsed.data })
        .then((r) => {
          if (cancelled) return;
          acceptSourceRevision(r);
          setReport(r.report ?? null);
          setFitBoards(r.boards);
          setFitState("Fit checked automatically");
        })
        .catch((e) => {
          if (!cancelled) {
            setFitState("Fit check unavailable");
            setFitError(enclosureErrorMessage(e));
          }
        });
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, design, board, preview, busy, client, projectId]);
  async function run(label: string, action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      if (mounted.current) setError(enclosureErrorMessage(e));
    } finally {
      running.current = false;
      if (mounted.current) setBusy("");
    }
  }
  useEffect(() => {
    mounted.current = true;
    void run("Loading enclosure…", async () => {
      const [r, p] = await Promise.all([call("status"), client.getProject(projectId)]);
      if (!mounted.current) return;
      revision.current = r.designRevision ?? null;
      setBoard(r.board ?? null);
      setCapabilities(r.capabilities ?? { pcb: false, cad: false });
      const initial = r.design
        ? MechanicalDesignSchema.parse(r.design)
        : defaultEnclosureDesign(r.board ?? null);
      savedDesign.current = structuredClone(initial);
      history.current.reset(initial);
      try {
        const store = new EnclosureRecoveryStore(
          localStorage,
          enclosureRecoveryKey(client.baseUrl, projectId, p.path),
        );
        recoveryStore.current = store;
        const recovered = store.load();
        if (recovered && !sameEnclosureDesign(recovered.design, initial))
          setPendingRecovery(recovered);
        else if (recovered) store.clear();
      } catch {
        recoveryStore.current = null;
        setRecoveryWarning(
          "Local draft recovery is unavailable. Save to the project before closing this workspace.",
        );
      }
      setLayoutChoice(r.design ? "keep" : "compact");
      setDesign(initial);
      setFiles(p.files.map((f) => f.path));
    });
    return () => {
      mounted.current = false;
    };
  }, [projectId]);
  useEffect(() => {
    if (!design || busy || pendingRecovery || !recoveryStore.current) return;
    try {
      if (dirty) {
        const stored = recoveryStore.current.store(design, revision.current);
        setRecoveryWarning(
          stored ? "" : "Finish the incomplete settings to update the local recovery copy.",
        );
      } else {
        recoveryStore.current.clear();
        setRecoveryWarning("");
      }
    } catch {
      setRecoveryWarning(
        "Could not update the local recovery copy. Save to the project before closing.",
      );
    }
  }, [design, dirty, busy, pendingRecovery]);
  useEffect(() => {
    if (!host.current) return;
    try {
      const s = new MechanicalScene(host.current, {
        select: (id) => placementHandlers.current.select(id),
        transform: (id, position, rotation) =>
          placementHandlers.current.transform(id, position, rotation),
        measured: () => {},
        zoom: () => {},
        error: setError,
      });
      scene.current = s;
      s.setPlanarPlacement(true);
      return () => {
        s.dispose();
        scene.current = null;
      };
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => {
    let cancel = false;
    void scene.current
      ?.setModels(renderedSources, false)
      .then(() => {
        const sourceReady =
          !!preview ||
          design?.mode !== "imported" ||
          !design.source?.path.toLowerCase().endsWith(".stl") ||
          modelSources.some((m) => m.item.path === design.source?.path);
        if (
          !cancel &&
          renderedSources.some((m) => m.item.kind === "board") &&
          sourceReady &&
          !framed.current
        ) {
          scene.current?.fit();
          framed.current = true;
        }
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancel = true;
    };
  }, [renderedSources]);
  useEffect(() => {
    const s = design?.space;
    const validSpace =
      s &&
      [s.x, s.y, s.floor, s.width, s.depth, s.height].every(Number.isFinite) &&
      s.width > 0 &&
      s.depth > 0 &&
      s.height > 0;
    scene.current?.setFitOverlay(
      showRisks
        ? focusedIssue
          ? (focusedIssue.regions ?? [])
          : (report?.issues
              .filter(
                (i) =>
                  i.severity === "error" || ["shell-surface", "shell-clearance"].includes(i.code),
              )
              .flatMap((i) => i.regions ?? []) ?? [])
        : [],
      showSpace && validSpace
        ? {
            name: "Usable interior",
            x: s.x,
            y: s.y,
            z: s.floor,
            width: s.width,
            depth: s.depth,
            height: s.height,
          }
        : null,
    );
  }, [report, focusedIssue, showRisks, showSpace, design]);
  function showIssue(issue: MechanicalFitIssue) {
    setFocusedIssue(issue);
    setShowRisks(true);
    scene.current?.focusFitRegions(issue.regions ?? []);
  }
  useEffect(() => {
    if (preview || !design) return;
    let cancelled = false;
    const models: SceneModel[] = design.obstacles.map((volume, i) => ({
      item: mechanicalItem(`@obstacle-${i}`, "import", volume.name),
      volume,
      origin: [0, 0, 0],
      selectable: false,
    }));
    const knownBoards = new Map((fitBoards ?? []).map((b) => [b.placement.path, b.features]));
    for (const [i, post] of design.mounts.entries()) {
      if (post.height <= 0 || post.outer <= post.diameter) continue;
      const item = mechanicalItem(`@mount-${i}`, "base", `Screw post ${i + 1}`);
      item.position = [post.x, post.y, design.space.floor];
      models.push({ item, post, origin: [0, 0, 0], selectable: false, enclosure: true });
    }
    if (board && !knownBoards.has("board.kicad_pcb")) knownBoards.set("board.kicad_pcb", board);
    for (const placement of design.boards) {
      const features = knownBoards.get(placement.path);
      if (!features) continue;
      const item = mechanicalItem(`@fit-${placement.path}`, "board", "PCB envelope");
      const pose = enclosureBoardPose(placement, features.outline);
      item.position = pose.position;
      item.rotation = pose.rotation;
      models.push({
        item,
        board: geometryFor(placement.path, features),
        thickness: features.thicknessMm,
        origin: pose.origin,
      });
    }
    setModelSources(models);
    const source = design.mode === "imported" ? design.source : null;
    if (source && /\.stl$/i.test(source.path))
      void (async () => {
        let data = sourceBuffers.current.get(source.path);
        if (!data) {
          const blob = await client.readFileBlob(projectId, source.path);
          if (blob.size > 50 * 1024 * 1024)
            throw new Error("Choose an enclosure smaller than 50 MB.");
          data = await blob.arrayBuffer();
          if (!cancelled) {
            sourceBuffers.current.set(source.path, data);
            while (sourceBuffers.current.size > 2) {
              const oldest = sourceBuffers.current.keys().next().value;
              if (oldest === undefined) break;
              sourceBuffers.current.delete(oldest);
            }
          }
        }
        const item = {
          ...mechanicalItem(source.path, "import", "Original enclosure"),
          position: source.position,
          rotation: source.rotation,
          scale: source.scale,
        };
        if (!cancelled)
          setModelSources([
            ...models,
            { item, data, origin: [0, 0, 0], selectable: false, enclosure: true },
          ]);
      })().catch((e) => {
        if (!cancelled) setError(enclosureErrorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [design, board, fitBoards, preview, client, projectId, sourceVersion]);
  function applyDraft(next: MechanicalDesign) {
    setDesign(next);
    setDirty(!savedDesign.current || !sameEnclosureDesign(next, savedDesign.current));
    setPreview(null);
    setReport(null);
    setFocusedIssue(null);
    setArchive(null);
    setEditReview(null);
    setNotice("");
    if (selectedBoard && !next.boards.some((b) => b.path === selectedBoard)) selectBoard(null);
  }
  function edit(next: MechanicalDesign, label = "Edit enclosure") {
    setLayoutProposals(null);
    if (history.current.commit(next, label)) applyDraft(next);
  }
  function space(key: keyof MechanicalDesign["space"], value: number) {
    if (design) {
      setLayoutChoice("keep");
      const next = { ...design, confirmed: false, space: { ...design.space, [key]: value } };
      edit(
        key === "floor" ? alignEnclosureMounts(next, mountingBoards(next)) : next,
        "Interior dimensions",
      );
    }
  }
  async function save(next = design) {
    const parsed = MechanicalDesignSchema.parse(next);
    const r = await call("save", { design: parsed, expectedDesignRevision: revision.current });
    if (!mounted.current) return;
    revision.current = r.designRevision ?? null;
    savedDesign.current = structuredClone(parsed);
    setDirty(false);
    setNotice("Settings saved in this project.");
  }
  async function importCase(file: File) {
    if (!design || pendingRecovery) return;
    await run("Importing enclosure…", async () => {
      validateEnclosureFile(file.name, file.size);
      const path = `cad/imports/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(-120)}`;
      if (/\.stl$/i.test(file.name)) {
        if (!scene.current)
          throw new Error("Reopen the CAD tab to restore the 3D viewer before importing STL.");
        await scene.current.validate({
          item: mechanicalItem(path, "import", file.name),
          data: await file.arrayBuffer(),
          origin: [0, 0, 0],
        });
      }
      if (!mounted.current) return;
      await client.writeFile(projectId, path, file);
      if (!mounted.current) return;
      setFiles((f) => [...f, path]);
      edit(
        {
          ...design,
          mode: "imported",
          confirmed: false,
          source: { path, scale: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
        },
        "Import enclosure",
      );
      setStep("Start");
      setNotice("Enclosure copied into this project. Confirm its units and usable interior.");
    });
  }
  async function showPreview(next = design) {
    if (!next) return;
    const design = next;
    await save(design);
    if (!mounted.current) return;
    const r = await call("preview", { design });
    if (!mounted.current) return;
    framed.current = false;
    setPreview(r);
    setReport(r.report ?? null);
    setFitError("");
    setFitState("Fit checked with preview");
    setFocusedIssue(null);
    const models: SceneModel[] = design.obstacles.map((volume, i) => ({
      item: mechanicalItem(`@obstacle-${i}`, "import", volume.name),
      volume,
      origin: [0, 0, 0],
      selectable: false,
    }));
    if (r.meshes)
      for (const kind of ["base", "lid"] as const) {
        const bytes = r.meshes[kind];
        if (bytes)
          models.push({
            item: mechanicalItem(
              `@case-${kind}.stl`,
              kind,
              kind === "base" ? "Enclosure preview" : "Lid",
            ),
            data: decodeMesh(bytes),
            origin: [0, 0, 0],
            selectable: false,
            enclosure: true,
          });
      }
    for (const b of r.boards ?? []) {
      const item = mechanicalItem(`@fit-${b.placement.path}`, "board", b.placement.path);
      const pose = enclosureBoardPose(b.placement, b.features.outline);
      item.position = pose.position;
      item.rotation = pose.rotation;
      models.push({
        item,
        board: geometryFor(b.placement.path, b.features),
        thickness: b.features.thicknessMm,
        origin: pose.origin,
      });
    }
    setModelSources(models);
    setNotice("");
    setTransparent(true);
    setShowSpace(false);
    setStep("Review");
  }
  async function makePreview(choice = layoutChoice) {
    if (!design) return;
    const checked = await call("check", { design });
    if (!mounted.current) return;
    setFitBoards(checked.boards);
    const inputs = (checked.boards ?? []).map((b) => ({
      ...b,
      ...(pcbModels.models[b.placement.path]?.pcbRevision === b.features.pcbRevision &&
      pcbModels.models[b.placement.path]?.bounds
        ? { modelBounds: pcbModels.models[b.placement.path]!.bounds! }
        : {}),
    }));
    const next = prepareEnclosurePreview(design, inputs, choice);
    edit(next, "Create case preview");
    await showPreview(next);
  }
  async function autoArrange(resize = false) {
    if (!design) return;
    const input = resize ? resizeEnclosureToFit(design) : design;
    if (design.mode === "imported" && !design.confirmed)
      throw new Error("Confirm the inside dimensions of your existing case before auto arranging.");
    const checked = await call("check", {
      design: { ...input, detailedFit: false, assemblyCheck: false },
    });
    if (!mounted.current) return;
    setFitBoards(checked.boards);
    const boards = (checked.boards ?? []).map((b) => ({
      ...b,
      ...(pcbModels.models[b.placement.path]?.bounds &&
      pcbModels.models[b.placement.path]?.pcbRevision === b.features.pcbRevision
        ? { modelBounds: pcbModels.models[b.placement.path]!.bounds! }
        : {}),
    }));
    const [choice] = await compareLayouts(input, boards, "compact");
    if (!mounted.current) return;
    if (choice?.error?.startsWith("No collision-free") && input.layoutLimit)
      throw new Error(
        `Could not find a layout within your ${input.layoutLimit.width} × ${input.layoutLimit.depth} mm case limit. Your layout is unchanged. ${design.mode === "generated" ? "Use Resize case to fit for a larger new case, or review your boards and constraints." : "Review your boards and constraints, or choose New case to create a larger enclosure."}`,
      );
    if (!choice?.proposal)
      throw new Error(choice?.error ?? "Could not arrange these boards. Your layout is unchanged.");
    framed.current = false;
    edit(choice.proposal.design, resize ? "Resize case and arrange boards" : "Auto arrange boards");
    setLayoutChoice("keep");
    selectBoard(null);
    setShowSpace(true);
    const review = choice.proposal.unresolved.length;
    const space = choice.proposal.design.space;
    setNotice(
      `Arranged ${design.boards.length} board${design.boards.length === 1 ? "" : "s"}. ` +
        (resize
          ? `Case sized to ${space.width + 2 * space.wall} × ${space.depth + 2 * space.wall} × ${space.floor + space.height + space.lid} mm outside. Previous size limit removed. `
          : "") +
        (review ? `${review} port connection${review === 1 ? "" : "s"} need review. ` : "") +
        "Preview to check the fit. Undo restores your previous layout.",
    );
  }
  function navigateIssue(destination: "Start" | "Space" | "PCB", code: string) {
    if (code === "no-board" || code === "board-geometry") {
      setStep("PCB");
      return;
    }
    if (["native-clearance", "outside-space", "board-collision"].includes(code)) {
      setStep("Start");
      return;
    }
    setStep("Start");
    if (destination === "Space") {
      setCaseDetails(true);
      requestAnimationFrame(() => {
        const root = caseSettings.current;
        const target = [...(root?.querySelectorAll("summary") ?? [])].find((s) =>
          s.textContent?.includes(
            code.includes("opening")
              ? "Connector openings"
              : code === "obstacle"
                ? "Obstacles"
                : "PCB holes & screw posts",
          ),
        );
        if (target?.parentElement instanceof HTMLDetailsElement) target.parentElement.open = true;
        (target ?? root)?.scrollIntoView({ block: "start" });
      });
    } else if (destination === "PCB") {
      setLayoutDetails(true);
      requestAnimationFrame(() => {
        const root = layoutSettings.current;
        const target = [...(root?.querySelectorAll("summary") ?? [])].find((s) =>
          s.textContent?.includes(
            code.startsWith("cable") ? "Cable connections" : "Ports & plug access",
          ),
        );
        if (target?.parentElement instanceof HTMLDetailsElement) target.parentElement.open = true;
        (target ?? root)?.scrollIntoView({ block: "start" });
      });
    } else setCustomSize(true);
  }
  async function download(path: string) {
    const blob = await client.readFileBlob(projectId, path);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = path.split("/").at(-1)!;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  async function build() {
    if (!preview?.revision) return;
    const r = await call("build", { design, expectedRevision: preview.revision });
    if (!mounted.current) return;
    setArchive(r.archive ?? null);
    setNotice("Your case and board files are ready to download.");
  }
  async function applyEdit() {
    if (!design || !board || !editReview) return;
    const change = planEnclosurePcbEdit(
      design,
      editReview === "outline"
        ? { kind: "outline" }
        : editReview === "move"
          ? { kind: "component", reference: component, x: move.x, y: move.y }
          : { kind: "hole", ...hole },
    );
    await call("edit_board", { design, expectedPcbRevision: board.pcbRevision, edit: change });
    const r = await call("status");
    setFitBoards(undefined);
    setBoard(r.board ?? null);
    setEditReview(null);
    setPreview(null);
    setReport(null);
    setArchive(null);
    setModelSources([]);
    setNotice("Actual PCB saved. Check fit again and run electrical DRC before fabrication.");
  }
  async function refreshConnections() {
    const result = await call("status");
    if (!mounted.current) return;
    setCapabilities(result.capabilities ?? { pcb: false, cad: false });
    if (result.board?.pcbRevision !== board?.pcbRevision) {
      setBoard(result.board ?? null);
      setFitBoards(undefined);
      setPreview(null);
      setReport(null);
      setArchive(null);
    }
    setNotice("Connection status refreshed. Your enclosure settings were kept.");
  }
  function connectionCard(kind: "pcb" | "cad") {
    return (
      <div className="fd-case-connection" role="status">
        <div>
          <strong>{kind === "pcb" ? "PCB editing" : "Imported-case editing"}</strong>
          <span className={capabilities[kind] ? "is-ready" : ""}>
            {capabilities[kind]
              ? "Connected"
              : kind === "cad" && cadRuntime?.status === "unsupported"
                ? "Unavailable here"
                : "Not connected"}
          </span>
        </div>
        {!capabilities[kind] && (
          <p>
            {kind === "cad"
              ? cadRuntime?.status === "unsupported"
                ? `${cadRuntime.message} You can still choose New enclosure to generate a case locally, or connect a compatible CAD backend.`
                : "Open Advanced CAD to set up the native CAD service, then check the connection here."
              : "Connect the FabPlane PCB backend to apply board edits. Positioning boards and checking fit remain available."}
          </p>
        )}
        <button
          type="button"
          disabled={!!busy}
          onClick={() => void run("Checking connections…", refreshConnections)}
        >
          Check connection
        </button>
      </div>
    );
  }
  const field = (key: keyof MechanicalDesign["space"], label: string, min = 0.1) => (
    <NumberField
      label={label}
      value={design!.space[key]}
      min={min}
      max={
        key === "x" || key === "y" ? 10000 : ["width", "depth", "height"].includes(key) ? 2000 : 20
      }
      onChange={(v) => space(key, v)}
    />
  );
  const actionsDisabled = !!busy || !!pendingRecovery || !design;
  const currentPlacement = design?.boards.find((b) => b.path === selectedBoard);
  const currentFeatures = selectedBoard ? featuresFor(selectedBoard) : null;
  const currentPose =
    currentPlacement && currentFeatures
      ? enclosureBoardPose(currentPlacement, currentFeatures.outline)
      : null;
  return (
    <section
      className="fd-case-workflow"
      hidden={!active}
      data-controls-expanded={controlsExpanded}
      aria-label="Enclosure designer"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = actionsDisabled ? "none" : "copy";
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (actionsDisabled) return;
        if (e.dataTransfer.files.length !== 1) {
          setError("Drop one STL or STEP enclosure at a time.");
          return;
        }
        const file = e.dataTransfer.files[0];
        if (file) void importCase(file);
      }}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable=true]"))
          return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
          e.preventDefault();
          e.stopPropagation();
          restoreHistory(e.shiftKey);
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
          e.preventDefault();
          e.stopPropagation();
          restoreHistory(true);
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          selectBoard(null);
        }
        if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          if (selectedBoard) scene.current?.focusModel(`@fit-${selectedBoard}`);
          else scene.current?.fit();
        }
      }}
    >
      <div className="fd-case-canvas" ref={host} />
      <aside className="fd-case-panel">
        <header>
          <div>
            <h2>Enclosure</h2>
            <p>Choose boards. Make a case. Check the fit.</p>
          </div>
          {dirty ? (
            <button
              className="fd-case-save-draft"
              disabled={actionsDisabled}
              onClick={() => void run("Saving settings…", save)}
            >
              Save draft
            </button>
          ) : (
            <small role="status">{revision.current ? "Saved" : "New case"}</small>
          )}
        </header>
        <nav aria-label="Enclosure workflow">
          {steps.map((s) => (
            <button
              key={s}
              aria-current={step === s ? "step" : undefined}
              disabled={!!busy}
              onClick={() => setStep(s)}
            >
              {stepLabels[s]}
            </button>
          ))}
        </nav>
        <div className="fd-case-body" ref={body}>
          <section className="fd-case-auto-arrange" aria-label="Automatic board placement">
            <button
              className="fd-mechanical-primary"
              disabled={
                actionsDisabled ||
                pcbModels.loading ||
                !design?.boards.length ||
                design.boards.every((b) => b.locked)
              }
              onClick={() => void run("Auto arranging boards…", () => autoArrange())}
            >
              {busy === "Auto arranging boards…"
                ? "Arranging…"
                : design?.mode === "generated" && !design.layoutLimit
                  ? "Auto arrange & size"
                  : "Auto arrange"}
            </button>
            {design?.mode === "generated" && design.layoutLimit && (
              <>
                <button
                  disabled={actionsDisabled || pcbModels.loading || !design.boards.length}
                  onClick={() => void run("Auto arranging boards…", () => autoArrange(true))}
                >
                  Resize case to fit
                </button>
                <small>
                  Auto arrange keeps your {design.layoutLimit.width} × {design.layoutLimit.depth} mm
                  limit. Resize case to fit removes that limit, sizes a new case and places the
                  boards. Undo restores both.
                </small>
              </>
            )}
            <small>
              {!design?.boards.length
                ? "Choose boards below to place them automatically."
                : pcbModels.loading
                  ? "Loading board shapes before arranging…"
                  : design.boards.every((b) => b.locked)
                    ? "All boards are locked. Unlock a board to arrange it."
                    : "Place boards and align ports in one click. Locked boards stay in place."}
            </small>
          </section>
          <EnclosureBoardDimensions
            paths={design?.boards.map((b) => b.path) ?? []}
            selected={selectedBoard}
            features={currentFeatures}
            disabled={actionsDisabled}
            onSelect={selectBoard}
            onFocus={() => selectedBoard && scene.current?.focusModel(`@fit-${selectedBoard}`)}
          />
          {selectedBoard && !pcbModels.models[selectedBoard] && (
            <p role="status" className="fd-mechanical-note">
              {pcbModels.loading
                ? "Loading this board’s 3D model… Its bounds are shown temporarily."
                : "This board’s 3D model is unavailable. The amber shape shows estimated bounds only. Open 3D details below for the cause and retry."}
            </p>
          )}
          {currentPlacement && (
            <section className="fd-case-placement" aria-label="Selected board controls">
              <div className="fd-case-placement-title">
                <strong>Position selected board</strong>
                <small>{currentPlacement.locked ? "Locked" : "Case stays fixed"}</small>
              </div>
              <div className="fd-case-placement-tools fd-case-placement-modes">
                {(
                  [
                    ["orbit", "Camera"],
                    ["translate", "Move"],
                    ["rotate", "Rotate"],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    disabled={
                      actionsDisabled ||
                      (mode !== "orbit" && (!!currentPlacement.locked || !currentFeatures))
                    }
                    aria-pressed={placementMode === mode}
                    onClick={() => setPlacementMode(mode)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="fd-case-placement-tools">
                <button
                  disabled={actionsDisabled || !!currentPlacement.locked || !currentFeatures}
                  onClick={() =>
                    currentFeatures &&
                    changePlacement(
                      editEnclosureBoardPose(
                        currentPlacement,
                        currentFeatures.outline,
                        "rotation",
                        (currentPlacement.rotation + 90) % 360,
                      ),
                    )
                  }
                >
                  Turn 90°
                </button>
                <button
                  disabled={actionsDisabled}
                  onClick={() =>
                    edit(
                      {
                        ...design!,
                        boards: design!.boards.map((b) =>
                          b.path === selectedBoard ? { ...b, locked: !b.locked } : b,
                        ),
                      },
                      "Board position lock",
                    )
                  }
                >
                  {currentPlacement.locked ? "Unlock board" : "Lock board"}
                </button>
              </div>
              <small role="status">
                {currentPlacement.locked
                  ? "Unlock to move or rotate this board."
                  : placementMode === "translate"
                    ? "Drag an arrow or square handle. Empty space moves the camera."
                    : placementMode === "rotate"
                      ? "Drag the ring, or use Turn 90°."
                      : "Choose Move or Rotate to position this board."}
              </small>
              <small>Moving a board requires a new preview to recheck ports and fit.</small>
            </section>
          )}
          {!!design?.boards.length && (
            <details className="fd-case-model-disclosure">
              <summary>
                {pcbModels.loading
                  ? "Reading board shapes…"
                  : pcbModels.error ||
                      Object.values(pcbModels.models).some((m) => m.coverage.missing.length)
                    ? "Some 3D parts need checking"
                    : "3D details & board downloads"}
              </summary>
              <PcbModelStatus {...pcbModels} />
            </details>
          )}
          {pendingRecovery && (
            <div className="fd-case-recovery" role="status">
              <strong>Resume your unsaved work?</strong>
              <p>
                A local draft from {new Date(pendingRecovery.savedAt).toLocaleString()} is
                available. Your saved project has not been changed.
              </p>
              {pendingRecovery.baseRevision !== revision.current && (
                <p>
                  Project settings have changed since this draft. Review the recovered settings
                  before saving.
                </p>
              )}
              <div>
                <button
                  className="fd-mechanical-primary"
                  onClick={() => {
                    const recovered = pendingRecovery;
                    setPendingRecovery(null);
                    edit(
                      recovered.baseRevision !== revision.current
                        ? { ...recovered.design, confirmed: false }
                        : recovered.design,
                      "Restore local draft",
                    );
                    setNotice(
                      "Local draft restored. Review it, then Save to keep it in this project.",
                    );
                  }}
                >
                  Restore draft
                </button>
                <button
                  onClick={() => {
                    try {
                      recoveryStore.current?.clear();
                    } catch {
                      setRecoveryWarning("Could not remove the local recovery copy.");
                      return;
                    }
                    setPendingRecovery(null);
                  }}
                >
                  Use saved version
                </button>
              </div>
            </div>
          )}
          {recoveryWarning && (
            <p className="fd-case-hint" role="status">
              {recoveryWarning}
            </p>
          )}
          {error && (
            <div className="fd-case-message is-error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="fd-case-message" role="status">
              {notice}
            </div>
          )}
          {design && (
            <fieldset disabled={!!busy || !!pendingRecovery} className="fd-case-fields">
              {step === "Start" && (
                <>
                  <h3>Choose your case</h3>
                  <p>We can size a new case for you, or use one you already have.</p>
                  <div className="fd-case-choices">
                    <button
                      aria-pressed={design.mode === "generated"}
                      onClick={() => {
                        if (design.mode !== "generated") {
                          edit({ ...design, mode: "generated", confirmed: false });
                          setLayoutChoice("compact");
                        }
                      }}
                    >
                      <strong>New case</strong>
                      <small>Size automatically</small>
                    </button>
                    <button
                      aria-pressed={design.mode === "imported"}
                      onClick={() => {
                        // Generated-only hardware must not leave an imported case blocked
                        // by settings that are hidden in this mode.
                        const { closure: _closure, holders: _holders, ...rest } = design;
                        edit({ ...rest, mode: "imported", confirmed: false });
                      }}
                    >
                      <strong>Existing case</strong>
                      <small>Import a file</small>
                    </button>
                  </div>
                  <EnclosureHardwarePanel design={design} onChange={edit} />
                  {design.mode === "imported" && (
                    <>
                      <label>
                        Enclosure file
                        <select
                          aria-label="Enclosure file"
                          value={design.source?.path ?? ""}
                          onChange={(e) =>
                            edit({
                              ...design,
                              confirmed: false,
                              source: {
                                path: e.target.value,
                                scale: 1,
                                position: [0, 0, 0],
                                rotation: [0, 0, 0],
                              },
                            })
                          }
                        >
                          <option value="">Choose STL or STEP…</option>
                          {files
                            .filter((p) => /\.(stl|step|stp)$/i.test(p))
                            .map((p) => (
                              <option key={p} value={p} title={p}>
                                {enclosureFileLabel(p)}
                              </option>
                            ))}
                        </select>
                      </label>
                      <button onClick={() => importInput.current?.click()}>
                        Import enclosure file
                      </button>
                      <p className="fd-case-hint">
                        Editing an imported solid requires FreeCAD. STL must be closed. Your
                        original file stays intact.
                      </p>
                      {connectionCard("cad")}
                      {design.source && /\.(step|stp)$/i.test(design.source.path) && (
                        <p className="fd-case-message" role="status">
                          STEP files appear after generating a preview with the CAD backend. Import
                          an STL copy for immediate visual positioning.
                        </p>
                      )}
                      {design.source && (
                        <details>
                          <summary>Import units and position</summary>
                          <NumberField
                            label="Unit scale (1 = mm)"
                            unit="×"
                            value={design.source.scale}
                            min={0.001}
                            onChange={(v) =>
                              edit({
                                ...design,
                                confirmed: false,
                                source: { ...design.source!, scale: v },
                              })
                            }
                          />
                          {(["X", "Y", "Z"] as const).map((a, i) => (
                            <NumberField
                              key={a}
                              label={`Import ${a}`}
                              value={design.source!.position[i]!}
                              onChange={(v) => {
                                const pos = [...design.source!.position] as [
                                  number,
                                  number,
                                  number,
                                ];
                                pos[i] = v;
                                edit({
                                  ...design,
                                  confirmed: false,
                                  source: { ...design.source!, position: pos },
                                });
                              }}
                            />
                          ))}
                        </details>
                      )}
                    </>
                  )}
                  {design.mode === "generated" && (
                    <>
                      <div className="fd-case-intro">
                        <h3>Layout</h3>
                      </div>
                      <div className="fd-case-simple-options" role="group" aria-label="Case layout">
                        {(
                          [
                            ["compact", "Small case", "Use less space", "Recommended"],
                            ["assembly", "More room", "Leave extra room between boards", ""],

                            ["keep", "Keep my layout", "Use the current size and positions", ""],
                          ] as const
                        ).map(([value, title, hint, badge]) => (
                          <button
                            key={value}
                            aria-pressed={layoutChoice === value}
                            onClick={() => {
                              setLayoutChoice(value);
                              setPreview(null);
                              setArchive(null);
                            }}
                          >
                            <span>
                              <strong>{title}</strong>
                              <small>{hint}</small>
                            </span>
                            {badge ? (
                              <em>{badge}</em>
                            ) : (
                              <span aria-hidden="true" className="fd-case-option-dot" />
                            )}
                          </button>
                        ))}
                      </div>
                      <p className="fd-case-hint">
                        {layoutChoice === "ports"
                          ? "Ports grouped on fewer sides. Change this in Ports, cables & fixed boards."
                          : layoutChoice === "keep"
                            ? `Current inside size: ${design.space.width} × ${design.space.depth} × ${design.space.height} mm.`
                            : "No measurements needed to start. Locks, fixed parts and custom openings are respected."}
                      </p>
                      <details
                        open={customSize}
                        onToggle={(e) => setCustomSize(e.currentTarget.open)}
                        className="fd-case-advanced"
                      >
                        <summary>Set a size or wall thickness</summary>
                        <p>Use a specific size instead of automatic sizing.</p>
                        <button
                          type="button"
                          onClick={() => {
                            setLayoutChoice("keep");
                            setPreview(null);
                            setArchive(null);
                          }}
                          disabled={layoutChoice === "keep"}
                        >
                          Use these dimensions
                        </button>
                        <h3>Inside size</h3>
                        <p>Change only what you need. Sizes are in millimetres.</p>
                        <div className="fd-case-grid">
                          {field("width", "Inside width")}
                          {field("depth", "Inside depth")}
                          {field("height", "Inside height")}
                        </div>
                        <details>
                          <summary>Wall thickness and origin</summary>
                          <div className="fd-case-grid">
                            {field("wall", "Wall thickness", 0.5)}
                            {field("floor", "Floor thickness", 0.5)}
                            {field("lid", "Lid thickness", 0.5)}
                            {field("x", "Interior X", -10000)}
                            {field("y", "Interior Y", -10000)}
                          </div>
                          <p>XY uses the PCB coordinate system. The floor starts at Z = 0.</p>
                        </details>
                      </details>
                    </>
                  )}
                  {design.mode === "imported" && (
                    <>
                      <h3>Inside size</h3>
                      <p>
                        For an existing case, measure the empty space inside. Sizes are in
                        millimetres.
                      </p>
                      <div className="fd-case-grid">
                        {field("width", "Inside width")}
                        {field("depth", "Inside depth")}
                        {field("height", "Inside height")}
                      </div>
                      <details>
                        <summary>Wall thickness and origin</summary>
                        <div className="fd-case-grid">
                          {field("wall", "Wall thickness", 0.5)}
                          {field("floor", "Floor thickness", 0.5)}
                          {field("lid", "Lid thickness", 0.5)}
                          {field("x", "Interior X", -10000)}
                          {field("y", "Interior Y", -10000)}
                        </div>
                        <p>XY uses the PCB coordinate system. The floor starts at Z = 0.</p>
                      </details>
                      {design.mode === "imported" && (
                        <label className="fd-case-check">
                          <input
                            type="checkbox"
                            checked={design.confirmed}
                            onChange={(e) => edit({ ...design, confirmed: e.target.checked })}
                          />
                          I checked these measurements against my case
                        </label>
                      )}
                    </>
                  )}
                </>
              )}
              {step === "Start" && (
                <details
                  ref={caseSettings}
                  className="fd-case-advanced"
                  open={caseDetails}
                  onToggle={(e) => setCaseDetails(e.currentTarget.open)}
                >
                  <summary>Fixed parts, screws & openings</summary>
                  <h3>Leave room for the real parts</h3>
                  <p>Add space occupied by batteries, hinges and other fixed parts.</p>
                  {field("clearance", "Minimum clearance", 0)}
                  <details>
                    <summary>Obstacles · {design.obstacles.length}</summary>
                    {design.obstacles.map((o, i) => (
                      <div className="fd-case-entry" key={i}>
                        <label>
                          Name
                          <input
                            aria-label={`Obstacle ${i + 1} name`}
                            value={o.name}
                            onChange={(e) =>
                              edit({
                                ...design,
                                obstacles: design.obstacles.map((p, j) =>
                                  j === i ? { ...p, name: e.target.value } : p,
                                ),
                              })
                            }
                          />
                        </label>
                        <div className="fd-case-grid">
                          {(["x", "y", "z", "width", "depth", "height"] as const).map((k) => (
                            <NumberField
                              key={k}
                              label={`${o.name} ${k}`}
                              value={o[k]}
                              min={["width", "depth", "height"].includes(k) ? 0.1 : -10000}
                              max={["width", "depth", "height"].includes(k) ? 2000 : 10000}
                              onChange={(v) =>
                                edit({
                                  ...design,
                                  obstacles: design.obstacles.map((p, j) =>
                                    j === i ? { ...p, [k]: v } : p,
                                  ),
                                })
                              }
                            />
                          ))}
                        </div>
                        <button
                          onClick={() =>
                            edit({
                              ...design,
                              obstacles: design.obstacles.filter((_, j) => j !== i),
                            })
                          }
                        >
                          Remove obstacle
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() =>
                        edit({
                          ...design,
                          obstacles: [
                            ...design.obstacles,
                            {
                              name: `Obstacle ${design.obstacles.length + 1}`,
                              x: design.space.x,
                              y: design.space.y,
                              z: design.space.floor,
                              width: 10,
                              depth: 10,
                              height: 5,
                            },
                          ],
                        })
                      }
                    >
                      Add obstacle
                    </button>
                  </details>
                  <details>
                    <summary>PCB holes & screw posts · {design.mounts.length} posts</summary>
                    <p>
                      Posts use the saved drill centres and follow linked boards. Bores are
                      unthreaded; set their diameter for your actual screw, pilot hole or insert
                      before printing.
                    </p>
                    {mountingBoards().map((b) => (
                      <div className="fd-case-entry" key={b.placement.path}>
                        <strong>
                          {enclosureFileLabel(b.placement.path)} · {b.features.holes.length}{" "}
                          detected holes
                        </strong>
                        <p>
                          {mountingCandidates(b.features).length} round mounting candidates ·{" "}
                          {b.features.holes.filter((h) => h.shape === "slot").length} slots.
                          Connector/pin holes are excluded from automatic posts.
                        </p>
                        <p>
                          Green rings align with posts; amber rings have no post. Routing vias are
                          not listed.
                        </p>
                        {!mountingCandidates(b.features).length && (
                          <p>
                            No round screw-mount holes detected. Do not drill the PCB without
                            checking its copper and components.
                          </p>
                        )}
                        {mountingCandidates(b.features).map((h, hi) => {
                          const m = mountAtHole(b, h, design.space.floor);
                          const exists = design.mounts.some(
                            (p) =>
                              (p.boardPath === b.placement.path && p.holeId === h.id) ||
                              Math.hypot(p.x - m.x, p.y - m.y) < 0.05,
                          );
                          return (
                            <div className="fd-case-hole-row" key={h.id ?? hi}>
                              <span>
                                <strong>
                                  {h.ref || `Hole ${hi + 1}`} · Ø{h.diameterMm} mm
                                </strong>
                                <small>
                                  X {m.x.toFixed(2)} · Y {m.y.toFixed(2)}
                                  {h.purpose === "unclassified"
                                    ? " · confirm this is a screw hole"
                                    : ""}
                                </small>
                              </span>
                              <button
                                disabled={exists || m.height < 0.5 || design.mounts.length >= 100}
                                onClick={() =>
                                  edit(
                                    { ...design, mounts: [...design.mounts, m] },
                                    "Add linked screw post",
                                  )
                                }
                              >
                                {exists ? "Post added" : "Add post"}
                              </button>
                            </div>
                          );
                        })}
                        <details>
                          <summary>All drill dimensions</summary>
                          <div className="fd-case-hole-list">
                            {b.features.holes.map((h, i) => (
                              <p key={h.id ?? i}>
                                {h.ref || "Edge.Cuts"} ·{" "}
                                {h.shape === "slot"
                                  ? `${h.drillWidthMm} × ${h.drillHeightMm} mm slot`
                                  : `Ø${h.diameterMm} mm`}{" "}
                                · {h.purpose ?? "review"} · PCB X {h.x}, Y {h.y}
                              </p>
                            ))}
                          </div>
                        </details>
                      </div>
                    ))}
                    <button
                      disabled={!design.mounts.length}
                      onClick={() =>
                        edit(
                          alignEnclosureMounts(
                            linkEnclosureMounts(design, mountingBoards()),
                            mountingBoards(),
                          ),
                          "Link and align screw posts",
                        )
                      }
                    >
                      Link & align posts to PCB holes
                    </button>
                    {design.mounts.map((m, i) => (
                      <details className="fd-case-entry" key={i}>
                        <summary>
                          Mount {i + 1} · Ø {m.diameter} mm bore
                        </summary>
                        {m.boardPath && (
                          <small>
                            Linked to {enclosureFileLabel(m.boardPath)} · follows board placement
                          </small>
                        )}
                        <div className="fd-case-grid">
                          {(["x", "y", "diameter", "outer", "height"] as const).map((k) => (
                            <NumberField
                              key={k}
                              label={`Mount ${i + 1} ${{ x: "X", y: "Y", diameter: "bore diameter", outer: "post diameter", height: "height" }[k]}`}
                              value={m[k]}
                              min={k === "x" || k === "y" ? -10000 : k === "outer" ? 1 : 0.5}
                              max={
                                k === "x" || k === "y"
                                  ? 10000
                                  : k === "outer"
                                    ? 40
                                    : k === "height"
                                      ? 100
                                      : 20
                              }
                              onChange={(v) =>
                                edit({
                                  ...design,
                                  mounts: design.mounts.map((p, j) =>
                                    j === i ? { ...p, [k]: v } : p,
                                  ),
                                })
                              }
                            />
                          ))}
                        </div>
                        <div className="fd-case-grid">
                          <NumberField
                            label={`Mount ${i + 1} screw head diameter`}
                            value={m.headDiameter ?? 0}
                            min={0.5}
                            max={40}
                            onChange={(v) =>
                              edit(
                                {
                                  ...design,
                                  mounts: design.mounts.map((p, j) =>
                                    j === i ? { ...p, headDiameter: v } : p,
                                  ),
                                },
                                "Set screw head diameter",
                              )
                            }
                          />
                          <NumberField
                            label={`Mount ${i + 1} screw head height`}
                            value={m.headHeight ?? 0}
                            min={0.1}
                            max={20}
                            onChange={(v) =>
                              edit(
                                {
                                  ...design,
                                  mounts: design.mounts.map((p, j) =>
                                    j === i ? { ...p, headHeight: v } : p,
                                  ),
                                },
                                "Set screw head height",
                              )
                            }
                          />
                          <NumberField
                            label={`Mount ${i + 1} screw shaft diameter`}
                            value={m.screwDiameter ?? 0}
                            min={0.5}
                            max={20}
                            onChange={(v) =>
                              edit(
                                {
                                  ...design,
                                  mounts: design.mounts.map((p, j) =>
                                    j === i ? { ...p, screwDiameter: v } : p,
                                  ),
                                },
                                "Set screw shaft diameter",
                              )
                            }
                          />
                          <NumberField
                            label={`Mount ${i + 1} screw length below head`}
                            value={m.screwLength ?? 0}
                            min={0.5}
                            max={100}
                            onChange={(v) =>
                              edit(
                                {
                                  ...design,
                                  mounts: design.mounts.map((p, j) =>
                                    j === i ? { ...p, screwLength: v } : p,
                                  ),
                                },
                                "Set screw length",
                              )
                            }
                          />
                        </div>
                        {(!m.headDiameter ||
                          !m.headHeight ||
                          !m.screwDiameter ||
                          !m.screwLength) && (
                          <small>
                            Enter measured screw/washer dimensions to check fit. Zero means not yet
                            specified. Thread engagement and print tolerances still need physical
                            verification.
                          </small>
                        )}
                        <button
                          onClick={() =>
                            edit({ ...design, mounts: design.mounts.filter((_, j) => j !== i) })
                          }
                        >
                          Remove mount
                        </button>
                      </details>
                    ))}
                    <button
                      onClick={() =>
                        edit({
                          ...design,
                          mounts: [
                            ...design.mounts,
                            {
                              x: design.space.x + 5,
                              y: design.space.y + 5,
                              diameter: 3,
                              outer: 6,
                              height: 3,
                            },
                          ],
                        })
                      }
                    >
                      Add mounting point
                    </button>
                  </details>
                  <details>
                    <summary>Connector openings · {design.openings.length}</summary>
                    {design.openings.map((o, i) => (
                      <div className="fd-case-entry" key={i}>
                        <label>
                          Opening shape
                          <select
                            aria-label={`${o.name} opening shape`}
                            value={o.shape ?? "rectangle"}
                            onChange={(e) =>
                              edit({
                                ...design,
                                openings: design.openings.map((p, j) =>
                                  j === i
                                    ? { ...p, shape: e.target.value as "rectangle" | "rounded" }
                                    : p,
                                ),
                              })
                            }
                          >
                            <option value="rounded">Rounded ends · USB-C</option>
                            <option value="rectangle">Rectangle</option>
                          </select>
                        </label>
                        <label>
                          Opening name
                          <input
                            value={o.name}
                            onChange={(e) =>
                              edit({
                                ...design,
                                openings: design.openings.map((p, j) =>
                                  j === i ? { ...p, name: e.target.value } : p,
                                ),
                              })
                            }
                          />
                        </label>
                        <label>
                          Wall
                          <select
                            value={o.wall}
                            onChange={(e) =>
                              edit({
                                ...design,
                                openings: design.openings.map((p, j) =>
                                  j === i ? { ...p, wall: e.target.value as typeof o.wall } : p,
                                ),
                              })
                            }
                          >
                            {(["minX", "maxX", "minY", "maxY"] as const).map((w) => (
                              <option key={w} value={w}>
                                {
                                  {
                                    minX: "Left (−X)",
                                    maxX: "Right (+X)",
                                    minY: "Front (−Y)",
                                    maxY: "Back (+Y)",
                                  }[w]
                                }
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="fd-case-grid">
                          {(["offset", "z", "width", "height"] as const).map((k) => (
                            <NumberField
                              key={k}
                              label={`${o.name} ${k}`}
                              value={o[k]}
                              min={k === "width" || k === "height" ? 0.1 : -10000}
                              max={k === "width" || k === "height" ? 2000 : 10000}
                              onChange={(v) =>
                                edit({
                                  ...design,
                                  openings: design.openings.map((p, j) =>
                                    j === i ? { ...p, [k]: v } : p,
                                  ),
                                })
                              }
                            />
                          ))}
                        </div>
                        <button
                          onClick={() =>
                            edit({ ...design, openings: design.openings.filter((_, j) => j !== i) })
                          }
                        >
                          Remove opening
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() =>
                        edit({
                          ...design,
                          openings: [
                            ...design.openings,
                            {
                              name: `Opening ${design.openings.length + 1}`,
                              wall: "minY",
                              offset: design.space.x + design.space.width / 2,
                              z: design.space.floor + 3,
                              width: 10,
                              height: 5,
                            },
                          ],
                        })
                      }
                    >
                      Add connector opening
                    </button>
                  </details>
                </details>
              )}
              {step === "Start" && (
                <details
                  ref={layoutSettings}
                  className="fd-case-advanced"
                  open={layoutDetails}
                  onToggle={(e) => setLayoutDetails(e.currentTarget.open)}
                >
                  <summary>Ports, cables & fixed boards</summary>
                  <EnclosureLayoutPanel
                    design={design}
                    boards={mountingBoards()}
                    busy={!!busy || pcbModels.loading}
                    proposals={layoutProposals}
                    showPlugs={showPlugs}
                    onShowPlugs={setShowPlugs}
                    onChange={edit}
                    onCancel={() => setLayoutProposals(null)}
                    onUse={(proposal) => {
                      edit(proposal.design, "Arrange boards and port openings");
                      setLayoutChoice("keep");
                      setNotice(
                        "Layout applied to the draft. Review fit and preview before export. Undo restores the previous layout.",
                      );
                    }}
                    onFind={() =>
                      void run("Comparing enclosure layouts…", async () => {
                        // Placement needs parsed features. Native body intersections run on
                        // Preview; repeating those here delays every layout comparison.
                        const r = await call("check", {
                          design: { ...design, detailedFit: false, assemblyCheck: false },
                        });
                        setFitBoards(r.boards);
                        const boards = (r.boards ?? []).map((b) => ({
                          ...b,
                          ...(pcbModels.models[b.placement.path]?.bounds &&
                          pcbModels.models[b.placement.path]?.pcbRevision === b.features.pcbRevision
                            ? { modelBounds: pcbModels.models[b.placement.path]!.bounds! }
                            : {}),
                        }));
                        if (mounted.current) await compareLayouts(design, boards);
                      })
                    }
                  />
                </details>
              )}
              {step === "PCB" && (
                <>
                  <EnclosureBoardPicker
                    files={enclosureSourceBoards(
                      files,
                      design.boards.map((b) => b.path),
                    )}
                    selected={design.boards.map((b) => b.path)}
                    onChange={(paths) => {
                      edit(selectEnclosureBoards(design, paths), "Choose boards");
                      if (design.mode === "generated") setLayoutChoice("compact");
                    }}
                  />
                  <details
                    className="fd-case-advanced"
                    open={manualPlacement}
                    onToggle={(e) => setManualPlacement(e.currentTarget.open)}
                  >
                    <summary>Move boards yourself</summary>
                    <section
                      className="fd-case-placement"
                      aria-label="Position boards in the enclosure"
                    >
                      <div className="fd-case-placement-title">
                        <strong>Position boards</strong>
                        <small>Case stays fixed</small>
                      </div>
                      <select
                        aria-label="Select board in 3D"
                        value={selectedBoard ?? ""}
                        disabled={!!busy}
                        onChange={(e) => selectBoard(e.target.value || null)}
                      >
                        <option value="">Click a board or choose one…</option>
                        {design?.boards.map((b) => (
                          <option key={b.path} value={b.path}>
                            {b.path === "board.kicad_pcb"
                              ? "Project PCB"
                              : enclosureFileLabel(b.path)}
                          </option>
                        ))}
                      </select>
                      {design.boards.map(
                        (b, i) =>
                          b.path === selectedBoard &&
                          currentPose && (
                            <div key={b.path} className="fd-case-board-fields">
                              <details>
                                <summary>Exact position</summary>
                                <div className="fd-case-grid">
                                  {(["x", "y", "z", "rotation"] as const).map((k) => (
                                    <NumberField
                                      key={k}
                                      label={
                                        {
                                          x: "Board center X",
                                          y: "Board center Y",
                                          z: "Height (Z)",
                                          rotation: "Rotation",
                                        }[k]
                                      }
                                      inputLabel={`Board ${i + 1} ${k}`}
                                      unit={k === "rotation" ? "°" : "mm"}
                                      min={k === "rotation" ? -360 : -10000}
                                      max={k === "rotation" ? 360 : 10000}
                                      value={
                                        k === "rotation"
                                          ? b.rotation
                                          : currentPose.position[{ x: 0, y: 1, z: 2 }[k]]!
                                      }
                                      onChange={(v) =>
                                        changePlacement(
                                          editEnclosureBoardPose(b, currentFeatures!.outline, k, v),
                                        )
                                      }
                                    />
                                  ))}
                                </div>
                              </details>
                              <button
                                onClick={() =>
                                  edit(
                                    selectEnclosureBoards(
                                      design,
                                      design.boards.filter((_, j) => j !== i).map((p) => p.path),
                                    ),
                                  )
                                }
                              >
                                Remove from enclosure
                              </button>
                            </div>
                          ),
                      )}
                      {currentPlacement && (
                        <>
                          {!currentPose && (
                            <p role="status">
                              Board geometry is not available yet. Open Preview if the fit check
                              reports a file problem.
                            </p>
                          )}
                          <small>
                            {placementMode === "translate"
                              ? "Drag an arrow or a square handle to move."
                              : placementMode === "rotate"
                                ? "Drag the ring to rotate the board flat."
                                : "Drag empty space to orbit. Scroll to zoom."}
                          </small>
                          <div className="fd-case-placement-tools">
                            <button
                              disabled={!selectedBoard || !!busy}
                              onClick={() =>
                                selectedBoard && scene.current?.focusModel(`@fit-${selectedBoard}`)
                              }
                            >
                              Focus board
                            </button>

                            <button
                              disabled={!currentFeatures || !design?.confirmed || !!busy}
                              title="Uses your confirmed interior dimensions; does not certify fit against the imported shell."
                              onClick={() => {
                                if (currentFeatures && design)
                                  changePlacement(
                                    centerEnclosureBoard(
                                      currentPlacement,
                                      currentFeatures.outline,
                                      design.space,
                                    ),
                                  );
                              }}
                            >
                              Center in usable space
                            </button>
                          </div>
                          <small>Center coordinates · PCB file unchanged</small>
                        </>
                      )}
                    </section>

                    {board && design.boards.some((b) => b.path === "board.kicad_pcb") && (
                      <details>
                        <summary>Edit actual project PCB</summary>
                        <p>
                          Changes board.kicad_pcb. Existing tracks are preserved; rerouting and
                          electrical DRC may be needed.
                        </p>
                        {connectionCard("pcb")}
                        {!design.confirmed && (
                          <p className="fd-case-hint">
                            Check the inside size under Case before applying PCB edits.
                          </p>
                        )}
                        <div className="fd-case-edit-modes" role="group" aria-label="PCB change">
                          {(
                            [
                              ["outline", "Outline"],
                              ["move", "Component"],
                              ["hole", "Hole"],
                            ] as const
                          ).map(([value, label]) => (
                            <button
                              key={value}
                              aria-pressed={pcbEditMode === value}
                              onClick={() => {
                                setPcbEditMode(value);
                                setEditReview(null);
                              }}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        {pcbEditMode === "outline" && (
                          <>
                            <p>
                              Use the confirmed interior, minus clearance, as the new rectangular
                              PCB boundary.
                            </p>
                            <button
                              disabled={
                                design.boards.find((b) => b.path === "board.kicad_pcb")
                                  ?.rotation !== 0
                              }
                              onClick={() => setEditReview("outline")}
                            >
                              Review outline change
                            </button>
                            {design.boards.find((b) => b.path === "board.kicad_pcb")?.rotation !==
                              0 && (
                              <p className="fd-case-hint">
                                Set the project PCB placement rotation to 0° before sizing its
                                outline.
                              </p>
                            )}
                          </>
                        )}
                        {pcbEditMode === "move" && (
                          <>
                            <p>
                              Move a component using its original PCB coordinates, in millimetres.
                            </p>
                            <label>
                              Component
                              <select
                                value={component}
                                onChange={(e) => {
                                  setComponent(e.target.value);
                                  setEditReview(null);
                                  const c = board.components?.find((c) => c.ref === e.target.value);
                                  if (c) setMove({ x: c.x, y: c.y, rotation: 0 });
                                }}
                              >
                                <option value="">Choose a component…</option>
                                {board.components?.map((c) => (
                                  <option key={c.ref}>{c.ref}</option>
                                ))}
                              </select>
                            </label>
                            <div className="fd-case-grid">
                              <NumberField
                                label="Component X"
                                value={move.x}
                                onChange={(v) => {
                                  setMove({ ...move, x: v });
                                  setEditReview(null);
                                }}
                              />
                              <NumberField
                                label="Component Y"
                                value={move.y}
                                onChange={(v) => {
                                  setMove({ ...move, y: v });
                                  setEditReview(null);
                                }}
                              />
                            </div>
                            <button disabled={!component} onClick={() => setEditReview("move")}>
                              Review component move
                            </button>
                          </>
                        )}
                        {pcbEditMode === "hole" && (
                          <>
                            <p>
                              Add a round board cutout using original PCB coordinates. Diameter:
                              0.5–20 mm.
                            </p>
                            <div className="fd-case-grid">
                              {(["x", "y", "diameter"] as const).map((k) => (
                                <NumberField
                                  key={k}
                                  label={`PCB hole ${k}`}
                                  value={hole[k]}
                                  min={k === "diameter" ? 0.5 : -10000}
                                  max={k === "diameter" ? 20 : 10000}
                                  onChange={(v) => {
                                    setHole({ ...hole, [k]: v });
                                    setEditReview(null);
                                  }}
                                />
                              ))}
                            </div>
                            <button
                              disabled={
                                !board.outline.closed ||
                                board.warnings?.some((w) =>
                                  w.startsWith("Non-rectangular Edge.Cuts"),
                                )
                              }
                              onClick={() => setEditReview("hole")}
                            >
                              Review mounting hole
                            </button>
                            {(!board.outline.closed ||
                              board.warnings?.some((w) =>
                                w.startsWith("Non-rectangular Edge.Cuts"),
                              )) && (
                              <p className="fd-case-hint">
                                This outline needs the PCB editor for hole placement. The
                                rectangular preview cannot prove a hole is inside the board.
                              </p>
                            )}
                          </>
                        )}
                        {editReview && (
                          <div className="fd-case-message">
                            <strong>
                              {editReview === "outline"
                                ? "Replace the PCB outline with the interior rectangle minus clearance?"
                                : editReview === "move"
                                  ? `Move ${component} to ${move.x}, ${move.y} mm?`
                                  : `Add a ${hole.diameter} mm board cutout at ${hole.x}, ${hole.y}?`}
                            </strong>
                            <p>
                              A recoverable native edit is saved. This does not check electrical
                              design rules.
                            </p>
                            <button
                              className="fd-mechanical-primary"
                              disabled={!capabilities.pcb || !design.confirmed}
                              onClick={() => void run("Saving PCB edit…", applyEdit)}
                            >
                              Apply PCB edit
                            </button>
                            <button onClick={() => setEditReview(null)}>Cancel</button>
                          </div>
                        )}
                      </details>
                    )}
                  </details>
                </>
              )}
              {step === "Review" && (
                <>
                  <h3>Your case preview</h3>
                  <p>
                    {design.boards.length} boards · {design.space.width} × {design.space.depth} ×{" "}
                    {design.space.height} mm inside
                  </p>
                  <div className="fd-case-preview-tools">
                    <button aria-pressed={transparent} onClick={() => setTransparent(!transparent)}>
                      See inside
                    </button>
                    <button onClick={() => scene.current?.fit()}>Fit view</button>
                  </div>
                  {design.mode === "generated" &&
                    report?.issues.some(
                      (i) =>
                        i.severity === "error" &&
                        ["native-clearance", "outside-space", "board-collision"].includes(i.code),
                    ) && (
                      <button
                        onClick={() => {
                          setLayoutChoice("assembly");
                          void run("Finding more room…", () => makePreview("assembly"));
                        }}
                      >
                        Try a roomier layout
                      </button>
                    )}
                  <details className="fd-case-recheck">
                    <summary>Run checks again</summary>
                    <button
                      onClick={() =>
                        void run("Checking clearances…", async () => {
                          const r = await call("check", { design });
                          acceptSourceRevision(r);
                          setFocusedIssue(null);
                          setFitBoards(r.boards);
                          setFitError("");
                          setFitState("Fit checked");
                          if (preview && r.revision !== preview.revision) {
                            setPreview(null);
                            setArchive(null);
                            setNotice("The design changed. Preview again before applying.");
                          }
                          setReport(
                            preview && r.revision === preview.revision
                              ? (preview.report ?? null)
                              : (r.report ?? null),
                          );
                        })
                      }
                    >
                      Check fit
                    </button>
                    <p className="fd-case-fit-state" role="status">
                      {preview ? "Fit checked with preview" : fitState}
                    </p>
                  </details>
                  {fitError && (
                    <p role="alert" className="fd-case-message is-error">
                      {fitError}
                    </p>
                  )}
                  {report && (
                    <EnclosureFitReview
                      report={report}
                      onNavigate={navigateIssue}
                      onShowIssue={showIssue}
                      focusedIssue={focusedIssue}
                    />
                  )}
                  {!preview && (
                    <p className="fd-case-hint">
                      Make a preview to see your case and check the fit.
                    </p>
                  )}
                  {design.mode === "imported" && !capabilities.cad && connectionCard("cad")}
                  {preview && (
                    <button
                      onClick={() => {
                        setPreview(null);
                        setModelSources([]);
                        setArchive(null);
                        setNotice("");
                      }}
                    >
                      Discard preview
                    </button>
                  )}
                </>
              )}
            </fieldset>
          )}
        </div>
        <footer>
          <div className="fd-case-footer-status">
            <span role="status">
              {busy ||
                (pcbModels.loading ? "Reading board shapes…" : "") ||
                (preview
                  ? "Preview ready"
                  : design?.mode === "imported" && !capabilities.cad
                    ? cadRuntime?.status === "unsupported"
                      ? "Imported-case editing unavailable here"
                      : "Connect CAD to preview this case"
                    : design?.confirmed
                      ? "Ready to preview"
                      : design?.mode === "generated"
                        ? "We’ll size the case for you"
                        : "Check your case measurements")}
            </span>
            <div className="fd-case-history" aria-label="Enclosure edit history">
              <button
                aria-label="Undo enclosure edit"
                title={
                  history.current.undoLabel
                    ? `Undo: ${history.current.undoLabel} (Ctrl/⌘ Z)`
                    : "Nothing to undo"
                }
                disabled={actionsDisabled || !history.current.undoLabel}
                onClick={() => restoreHistory()}
              >
                <MechanicalIcon name="undo" />
              </button>
              <button
                aria-label="Redo enclosure edit"
                title={
                  history.current.redoLabel
                    ? `Redo: ${history.current.redoLabel} (Ctrl/⌘ Shift Z)`
                    : "Nothing to redo"
                }
                disabled={actionsDisabled || !history.current.redoLabel}
                onClick={() => restoreHistory(true)}
              >
                <MechanicalIcon name="redo" />
              </button>
            </div>
          </div>
          <div>
            {step !== "PCB" && (
              <button
                className="fd-case-back"
                disabled={actionsDisabled}
                onClick={() => setStep(steps[steps.indexOf(step) - 1]!)}
              >
                Back
              </button>
            )}
            {step === "PCB" ? (
              <button
                className="fd-mechanical-primary"
                disabled={actionsDisabled || !design?.boards.length}
                onClick={() => setStep("Start")}
              >
                Choose a case
              </button>
            ) : step === "Start" ? (
              <button
                className="fd-mechanical-primary"
                disabled={
                  actionsDisabled ||
                  pcbModels.loading ||
                  !design?.boards.length ||
                  (design.mode === "imported" &&
                    (!design.confirmed || !design.source?.path || !capabilities.cad))
                }
                onClick={() => void run("Making your case…", makePreview)}
              >
                {pcbModels.loading ? "Reading boards…" : "Make preview"}
              </button>
            ) : archive ? (
              <button
                className="fd-mechanical-primary"
                disabled={actionsDisabled}
                onClick={() => void run("Preparing download…", () => download(archive))}
              >
                Download files
              </button>
            ) : preview ? (
              <button
                className="fd-mechanical-primary"
                disabled={actionsDisabled || pcbModels.loading || report?.status === "blocked"}
                onClick={() => void run("Saving matched designs…", build)}
              >
                Save design files
              </button>
            ) : (
              <button
                className="fd-mechanical-primary"
                disabled={
                  actionsDisabled ||
                  pcbModels.loading ||
                  !design?.boards.length ||
                  (design.mode === "imported" &&
                    (!design.confirmed || !design.source?.path || !capabilities.cad))
                }
                onClick={() => void run("Making your case…", makePreview)}
              >
                {pcbModels.loading ? "Reading boards…" : "Make preview"}
              </button>
            )}
          </div>
        </footer>
      </aside>
      <div className="fd-case-hud" data-collapsed={!controlsExpanded}>
        <button
          className="fd-case-controls-toggle"
          aria-expanded={controlsExpanded}
          aria-controls={sceneToolsId}
          onClick={() => setControlsExpanded(!controlsExpanded)}
        >
          <span>View & fit</span>
          <span aria-hidden="true">{controlsExpanded ? "−" : "+"}</span>
        </button>
        <div className="fd-case-tools-body" id={sceneToolsId} hidden={!controlsExpanded}>
          <section className="fd-case-view-section" aria-label="Scene view">
            <h3>View</h3>
            <div className="fd-case-view-tools">
              <button onClick={() => scene.current?.view("top")}>Top view</button>
              <button onClick={() => scene.current?.view("iso")}>3D view</button>
              {(design?.source || preview) && (
                <button aria-pressed={!caseVisible} onClick={() => setCaseVisible(!caseVisible)}>
                  {caseVisible ? "Hide case" : "Show case"}
                </button>
              )}
              <button aria-pressed={showRisks} onClick={() => setShowRisks(!showRisks)}>
                Fit risks
              </button>
              <button aria-pressed={showSpace} onClick={() => setShowSpace(!showSpace)}>
                Usable space
              </button>
              {preview?.meshes?.lid && (
                <button aria-pressed={openLid} onClick={() => setOpenLid(!openLid)}>
                  {openLid ? "Close lid" : "Open lid"}
                </button>
              )}
              <button aria-pressed={transparent} onClick={() => setTransparent(!transparent)}>
                See through
              </button>
            </div>
          </section>
          <div className="fd-case-fit-legend" aria-label="Fit overlay legend">
            <h3>Fit guidance</h3>
            {design?.mode === "imported" && (
              <>
                <strong>Check the actual case walls</strong>
                <small>
                  {report?.issues.some((i) => i.code === "shell-coverage")
                    ? "STL surface risks are highlighted using estimated part boxes. Review real shapes and mounting holes."
                    : "Red checks use your defined interior. Surface checks are unavailable for this case; inspect its walls visually."}
                </small>
                <button
                  onClick={() => {
                    setStep("Start");
                    setShowSpace(true);
                  }}
                >
                  Set usable interior
                </button>
              </>
            )}
            <span>
              <i className="is-risk" />
              Red: affected parts / clearance risk
            </span>
            {showSpace && (
              <span>
                <i className="is-space" />
                Dashed: usable interior
              </span>
            )}
            <small>Estimated bounds · Not exact surface collisions</small>
            {!preview && <small role="status">{fitState}</small>}
            {focusedIssue ? (
              <>
                <strong>
                  Selected: {[...new Set(focusedIssue.regions?.map((r) => r.name))].join(", ")}
                </strong>
                <button
                  onClick={() => {
                    setFocusedIssue(null);
                    scene.current?.fit();
                  }}
                >
                  Show all issues
                </button>
              </>
            ) : report?.status === "blocked" && step !== "Review" ? (
              <button onClick={() => setStep("Review")}>Review fit issues</button>
            ) : null}
            {!showRisks && <small>Red highlights hidden</small>}
          </div>
        </div>
      </div>
      <div className="fd-case-canvas-note">
        <strong>
          {preview
            ? "Enclosure preview"
            : design?.mode === "imported" && design.source
              ? "Original enclosure · Unchanged"
              : "PCB reference"}
        </strong>
        <span>Click a board to select · Drag empty space to orbit · Scroll to zoom</span>
        <button onClick={() => scene.current?.fit()}>Fit view</button>
      </div>
      <input
        hidden
        ref={importInput}
        type="file"
        accept=".stl,.step,.stp"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void importCase(file);
        }}
      />
    </section>
  );
}
