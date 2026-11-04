import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
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
  refreshEnclosureOpenings,
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
  type MechanicalItem,
  mountingCandidates,
  mountAtHole,
  alignEnclosureMounts,
  linkEnclosureMounts,
  type LayoutBoard,
  nativeEnclosureClearanceIssues,
  enclosureReviewTarget,
  enclosureReviewTargets,
  type EnclosureReviewTarget,
} from "@fabdesk/client-core";
import { MechanicalScene, type SceneModel, type BoardGeometry } from "./MechanicalScene";
import {
  EnclosureFitReview,
  FitProblem,
  fitProblemCount,
  fitProblemTitle,
} from "./EnclosureFitReview";
import { placeReviewCallouts, type PlacedReviewCallout } from "./review-callout";
import { MechanicalIcon } from "./MechanicalIcon";
import { MechanicalViewCube } from "./MechanicalViewCube";
import { EnclosureConnections } from "./EnclosureConnections";
import EnclosureLayoutWorker from "./enclosure-layout.worker?worker&inline";
import "./enclosure-compact.css";
import { detailedBoardSource, usePcbModels } from "./usePcbModels";
import { NumberField } from "./EnclosureNumberField";
import { EnclosureLayoutPanel, type LayoutChoice } from "./EnclosureLayoutPanel";
import { EnclosureBoardPicker } from "./EnclosureBoardPicker";
import { EnclosureBoardDimensions } from "./EnclosureBoardDimensions";
import { EnclosureHardwarePanel } from "./EnclosureHardwarePanel";
import { PcbModelStatus } from "./PcbModelStatus";
import { PcbModelHealth } from "./PcbModelHealth";
import { revealEnclosureControl } from "./reveal-enclosure-control";
import { parseWorkspaceView, type WorkspaceView } from "./workspace-view";
import {
  enclosureReadiness,
  fitIssueBoardPath,
  enclosureRecoveryAction,
  enclosureWorkflow,
  enclosureSelectionKey,
  enclosureIssueRoute,
  type EnclosureIssueTarget,
} from "@fabdesk/client-core";

type Result = {
  verificationPending?: boolean;
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
export type EnclosureWorkspaceController = {
  transformBoard: (
    id: string,
    position: [number, number, number],
    rotation: [number, number, number],
  ) => void;
  openConnections: () => void;
  openGenerator: () => void;
  openReview: () => void;
  openExport: () => void;
  saveDraft: () => Promise<void>;
  undo: (redo?: boolean) => void;
  useImportedCase: (item: MechanicalItem, mesh: Blob) => Promise<void>;
};
/** Guided enclosure workflow; all preview coordinates are in the saved PCB frame, in mm. */
export function EnclosureDesigner({
  projectId,
  active = true,
  onStatusChange,
  cadRuntime = null,
  controllerRef,
  onAssemblyModelsChange,
  onContextChange,
  onReviewCountChange,
  onConnectionsChange,
  onHistoryChange,
}: {
  projectId: string;
  active?: boolean;
  onStatusChange?: (status: string) => void;
  cadRuntime?: CadRuntimeState | null;
  controllerRef?: RefObject<EnclosureWorkspaceController | null>;
  onAssemblyModelsChange?: (models: SceneModel[]) => void;
  onContextChange?: (context: string | null) => void;
  onReviewCountChange?: (count: number) => void;
  onConnectionsChange?: (open: boolean) => void;
  onHistoryChange?: (history: { canUndo: boolean; canRedo: boolean }) => void;
}) {
  const client = useCoreClient();
  const viewKey = useRef<string | null>(null);
  const restoredView = useRef<WorkspaceView | null>(null);
  const [layoutChoice, setLayoutChoice] = useState<EnclosureLayoutGoal | "keep">("compact");
  const [caseDetails, setCaseDetails] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [choosingBoards, setChoosingBoards] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [viewMenu, setViewMenu] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [orientation, setOrientation] = useState<[number, number, number, number]>([0, 0, 0, 1]);
  const [selectedCase, setSelectedCase] = useState<string | null>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  const [annotations, setAnnotations] = useState<PlacedReviewCallout[]>([]);
  const callouts = useRef<HTMLDivElement>(null);
  const calloutSizes = useRef(new Map<string, { width: number; height: number }>());
  const updateAnnotation = useRef(() => {});
  const previewStart = useRef<{
    design: MechanicalDesign;
    layout: EnclosureLayoutGoal | "keep";
    confirmed: string | null;
  } | null>(null);
  useEffect(() => {
    previewStart.current = null;
    setAdvanced(false);
    setReviewOpen(false);
    setExportOpen(false);
    setChoosingBoards(false);
    setConnectionsOpen(false);
    setSelectedCase(null);
    setViewMenu(false);
  }, [projectId]);
  const [layoutDetails, setLayoutDetails] = useState(false);
  const [manualPlacement, setManualPlacement] = useState(false);
  const [customSize, setCustomSize] = useState(false);
  const [issueControl, setIssueControl] = useState<{
    target: EnclosureIssueTarget;
    boardPath: string | null;
    notice: string;
  } | null>(null);
  const [layoutProposals, setLayoutProposals] = useState<LayoutChoice[] | null>(null);
  const cancelLayout = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelLayout.current?.(), [projectId]);
  async function compareLayouts(
    value: MechanicalDesign,
    boards: LayoutBoard[],
    goal?: EnclosureLayoutGoal,
  ) {
    cancelLayout.current?.();
    // Keep the worker with this loaded UI: a desktop rebuild may replace external hashed assets.
    const worker = new EnclosureLayoutWorker();
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
  const [confirmedSelection, setConfirmedSelection] = useState<string | null>(null);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false),
    [preview, setPreview] = useState<Result | null>(null),
    [baseReport, setReport] = useState<MechanicalFitReport | null>(null);
  const [pendingRecovery, setPendingRecovery] = useState<EnclosureRecovery | null>(null);
  useEffect(() => {
    if (pendingRecovery) setAdvanced(true);
  }, [pendingRecovery]);
  const [recoveryWarning, setRecoveryWarning] = useState("");
  const recoveryStore = useRef<EnclosureRecoveryStore | null>(null);
  const [archive, setArchive] = useState<string | null>(null),
    [component, setComponent] = useState(""),
    [move, setMove] = useState({ x: 0, y: 0, rotation: 0 });
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
    active || !!onAssemblyModelsChange,
  );
  useEffect(() => {
    onStatusChange?.(
      busy ||
        (pendingRecovery
          ? "Local draft available"
          : error
            ? "Enclosure needs attention"
            : pcbModels.loading
              ? `Loading board models · ${Object.keys(pcbModels.models).length}/${pcbModels.requested}`
              : pcbModels.error
                ? "Board models need attention"
                : dirty
                  ? "Unsaved enclosure changes"
                  : preview
                    ? "Enclosure preview"
                    : "Enclosure settings loaded"),
    );
  }, [
    busy,
    dirty,
    preview,
    error,
    pendingRecovery,
    pcbModels.loading,
    pcbModels.error,
    pcbModels.models,
    pcbModels.requested,
    onStatusChange,
  ]);
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
            item: {
              ...source.item,
              name: pcbModels.loading
                ? "Loading PCB model…"
                : "PCB bounds · detailed model unavailable",
            },
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
    [
      modelSources,
      pcbModels.models,
      pcbModels.loading,
      showPlugs,
      design,
      fitBoards,
      preview,
      board,
    ],
  );
  const [fitState, setFitState] = useState(""),
    [fitError, setFitError] = useState("");
  const [showRisks, setShowRisks] = useState(true),
    [showSpace, setShowSpace] = useState(false);
  const [focusedIssue, setFocusedIssue] = useState<MechanicalFitIssue | null>(null);
  const [focusedTarget, setFocusedTarget] = useState<EnclosureReviewTarget | null>(null);
  const [selectedBoard, setSelectedBoard] = useState<string | null>(null);
  const viewState = useRef({ step, selected: selectedBoard, confirmedSelection });
  viewState.current = { step, selected: selectedBoard, confirmedSelection };
  const [placementMode, setPlacementMode] = useState<"orbit" | "translate" | "rotate" | "measure">(
    "orbit",
  );
  const [caseVisible, setCaseVisible] = useState(true);
  const [controlsExpanded, setControlsExpanded] = useState(false);
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
      if (next && next !== compact) setControlsExpanded(false);
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
  function reviewTarget(issue: MechanicalFitIssue) {
    return design ? enclosureReviewTarget(issue, design, mountingBoards()) : null;
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
    setSelectedCase(null);
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
    select: (id) => {
      if (busy || pendingRecovery) return;
      if (id && (id.startsWith("@case-") || id === design?.source?.path)) {
        setSelectedBoard(null);
        setSelectedCase(id);
        setPlacementMode("orbit");
      } else selectBoard(id?.startsWith("@fit-") ? id.slice(5) : null);
    },
    transform: (id, position, rotation) => {
      if (busy || pendingRecovery || !design) return;
      if (id === design.source?.path) {
        edit(
          { ...design, confirmed: false, source: { ...design.source, position, rotation } },
          "Position enclosure",
        );
        return;
      }
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
    scene.current?.select(selectedBoard ? `@fit-${selectedBoard}` : selectedCase);
    scene.current?.setPlanarPlacement(!selectedCase);
    scene.current?.setMode(
      busy ||
        pendingRecovery ||
        design?.boards.find((b) => b.path === selectedBoard)?.locked ||
        (selectedCase?.startsWith("@case-") && placementMode !== "measure")
        ? "orbit"
        : placementMode,
    );
  }, [selectedBoard, selectedCase, placementMode, busy, pendingRecovery, renderedSources, design]);
  useEffect(() => {
    onAssemblyModelsChange?.(
      renderedSources
        .filter((m) => m.item.kind === "board" || m.guide)
        .map((m) => ({
          ...m,
          item:
            m.item.kind === "board"
              ? {
                  ...m.item,
                  name: enclosureFileLabel(m.item.id.slice(5)).replace(/\.kicad_pcb$/i, ""),
                }
              : m.item,
          ...(m.item.kind === "board"
            ? {
                transformable:
                  !busy &&
                  !pendingRecovery &&
                  !design?.boards.find((b) => `@fit-${b.path}` === m.item.id)?.locked,
              }
            : {}),
        })),
    );
  }, [renderedSources, onAssemblyModelsChange, design?.boards, busy, pendingRecovery]);
  useEffect(() => {
    onHistoryChange?.({
      canUndo: !busy && !pendingRecovery && !!history.current.undoLabel,
      canRedo: !busy && !pendingRecovery && !!history.current.redoLabel,
    });
  }, [design, busy, pendingRecovery, onHistoryChange]);
  useEffect(() => {
    onContextChange?.(
      preview
        ? "Enclosure preview"
        : design?.source
          ? enclosureFileLabel(design.source.path)
          : null,
    );
  }, [preview, design?.source?.path, onContextChange]);
  useEffect(() => {
    onReviewCountChange?.(report?.issues.length ?? 0);
  }, [report, onReviewCountChange]);
  useEffect(() => {
    onConnectionsChange?.(connectionsOpen);
  }, [connectionsOpen, onConnectionsChange]);
  useEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = {
      transformBoard: (...args) => placementHandlers.current.transform(...args),
      openConnections: () => {
        if (pendingRecovery) {
          setAdvanced(true);
          return;
        }
        setAdvanced(false);
        setConnectionsOpen(true);
        setReviewOpen(false);
        setExportOpen(false);
        setViewMenu(false);
        setShowPlugs(true);
      },
      openGenerator: () => {
        if (pendingRecovery) {
          setAdvanced(true);
          return;
        }
        setAdvanced(false);
        setConnectionsOpen(false);
        setReviewOpen(false);
        setExportOpen(false);
        setViewMenu(false);
        setShowPlugs(false);
      },
      openReview: () => {
        if (pendingRecovery) {
          setAdvanced(true);
          return;
        }
        setAdvanced(false);
        setConnectionsOpen(false);
        setReviewOpen(true);
        setExportOpen(false);
      },
      openExport: () => {
        if (pendingRecovery) {
          setAdvanced(true);
          return;
        }
        setAdvanced(false);
        setConnectionsOpen(false);
        setReviewOpen(false);
        setExportOpen(true);
      },
      saveDraft: () => run("Saving settings…", save),
      undo: restoreHistory,
      useImportedCase: async (item, mesh) => {
        if (!design || busy || pendingRecovery) return;
        await run("Preparing existing case…", async () => {
          const path = `cad/imports/${crypto.randomUUID()}-fit-${item.name
            .replace(/\.[^.]+$/, "")
            .replace(/[^a-zA-Z0-9_-]/g, "-")
            .slice(-80)}.stl`;
          await client.writeFile(projectId, path, mesh);
          if (!mounted.current) return;
          const { closure: _closure, holders: _holders, ...rest } = design;
          edit(
            {
              ...rest,
              mode: "imported",
              confirmed: false,
              source: { path, scale: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
            },
            "Use imported enclosure",
          );
          setFiles((f) => [...f, path]);
          setLayoutChoice("keep");
          setConnectionsOpen(false);
          setAdvanced(false);
          setSelectedBoard(null);
          setSelectedCase(path);
          setStep("Start");
          setNotice("Original model preserved. Confirm the usable inside size before previewing.");
        });
      },
    };
    return () => {
      controllerRef.current = null;
    };
  });
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
  useEffect(() => {
    // Reveal after the step's scroll reset, even when the window is in the background.
    if (issueControl) {
      revealEnclosureControl(body.current, issueControl.target, issueControl.boardPath);
      setNotice(issueControl.notice);
    }
  }, [issueControl]);
  const [capabilities, setCapabilities] = useState({ pcb: false, cad: false });
  const [openLid, setOpenLid] = useState(true),
    [transparent, setTransparent] = useState(false);
  useEffect(() => {
    const separation = Math.max(
      25,
      Math.min(180, Math.max(design?.space.width ?? 0, design?.space.depth ?? 0) * 0.65),
    );
    scene.current?.setExplode(openLid && preview?.meshes?.lid ? separation : 0, false);
  }, [openLid, preview?.meshes?.lid, design?.space.width, design?.space.depth]);
  useEffect(() => {
    scene.current?.setTranslucent(transparent);
  }, [transparent, renderedSources]);
  async function call(action: string, extra: Record<string, unknown> = {}) {
    return unpack(await client.callTool("cad_fit", { projectId, action, ...extra }));
  }
  // Debounce edits; old responses never paint a newer design or replace a preview's report.
  useEffect(() => {
    if ((!active && !onAssemblyModelsChange) || !design || preview || busy) return;
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
      let restoredDraft: MechanicalDesign | null = null;
      let approvedSelection = r.design?.confirmed
        ? enclosureSelectionKey(initial.boards.map((b) => b.path))
        : null;
      try {
        const store = new EnclosureRecoveryStore(
          localStorage,
          enclosureRecoveryKey(client.baseUrl, projectId, p.path),
        );
        recoveryStore.current = store;
        viewKey.current = `${store.key}:view`;
        try {
          const view = JSON.parse(sessionStorage.getItem(viewKey.current) ?? "null");
          restoredView.current = parseWorkspaceView(view?.camera);
          if (steps.includes(view?.step)) setStep(view.step);
          if (typeof view?.selected === "string") setSelectedBoard(view.selected);
          if (view && "confirmedSelection" in view)
            approvedSelection =
              typeof view.confirmedSelection === "string" ? view.confirmedSelection : null;
        } catch {
          /* A missing or invalid view must not prevent draft recovery. */
        }
        const recovered = store.load();
        const recoveryAction = enclosureRecoveryAction(recovered, initial, revision.current);
        if (recovered && (recoveryAction === "restore" || recoveryAction === "conflict")) {
          if (recoveryAction === "restore") {
            history.current.commit(recovered.design, "Restore local draft");
            restoredDraft = recovered.design;
            setDirty(true);
            setNotice("Your unsaved draft was restored. Undo returns to the saved design.");
          } else setPendingRecovery(recovered);
        } else if (recoveryAction === "discard") store.clear();
      } catch {
        recoveryStore.current = null;
        setRecoveryWarning(
          "Local draft recovery is unavailable. Save to the project before closing this workspace.",
        );
      }
      setLayoutChoice(r.design ? "keep" : "compact");
      setConfirmedSelection(approvedSelection);
      setDesign(restoredDraft ?? initial);
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
        measured: setMeasured,
        zoom: setZoom,
        orientation: setOrientation,
        viewChanged: () => updateAnnotation.current(),
        error: setError,
      });
      scene.current = s;
      s.setPlanarPlacement(true);
      return () => {
        rememberView();
        s.dispose();
        scene.current = null;
      };
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => {
    if (!active) return;
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
          if (restoredView.current) {
            scene.current?.restoreView(restoredView.current);
            restoredView.current = null;
          }
          framed.current = true;
        }
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancel = true;
    };
  }, [renderedSources, active]);
  function rememberView() {
    if (!viewKey.current || !scene.current || !framed.current) return;
    try {
      sessionStorage.setItem(
        viewKey.current,
        JSON.stringify({ camera: scene.current.getView(), ...viewState.current }),
      );
    } catch {
      /* View preferences are optional; design recovery reports its own failures. */
    }
  }
  useEffect(() => {
    if (!active) rememberView();
    window.addEventListener("pagehide", rememberView);
    return () => {
      rememberView();
      window.removeEventListener("pagehide", rememberView);
    };
  }, [active, step, selectedBoard, confirmedSelection, projectId]);
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
        ? focusedIssue && (advanced || reviewOpen)
          ? ((focusedTarget ?? reviewTarget(focusedIssue))?.regions ?? [])
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
  }, [
    report,
    focusedIssue,
    focusedTarget,
    showRisks,
    showSpace,
    design,
    fitBoards,
    preview,
    advanced,
    reviewOpen,
  ]);
  function showIssue(issue: MechanicalFitIssue, target: EnclosureReviewTarget | null = null) {
    setFocusedIssue(issue);
    setFocusedTarget(
      target ??
        (!advanced && design
          ? (enclosureReviewTargets(issue, design, mountingBoards())[0] ?? null)
          : null),
    );
    setShowRisks(true);
  }
  function clearIssue() {
    setFocusedIssue(null);
    setFocusedTarget(null);
  }
  function closeReview() {
    setReviewOpen(false);
    clearIssue();
  }
  useEffect(() => {
    if (!focusedIssue || focusedIssue.code === "coverage") return;
    const current = report?.issues.find(
      (issue) =>
        issue.code === focusedIssue.code &&
        issue.severity === focusedIssue.severity &&
        issue.message === focusedIssue.message,
    );
    if (current !== focusedIssue) {
      setFocusedIssue(current ?? null);
      setFocusedTarget((previous) =>
        current && previous && design
          ? (enclosureReviewTargets(current, design, mountingBoards()).find(
              (target) =>
                target.kind === previous.kind &&
                target.boardPath === previous.boardPath &&
                (previous.reference
                  ? target.reference === previous.reference
                  : target.regions[0]?.name === previous.regions[0]?.name),
            ) ?? null)
          : null,
      );
    }
  }, [report, focusedIssue]);
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
            {
              item,
              data,
              origin: [0, 0, 0],
              selectable: true,
              transformable: true,
              enclosure: true,
            },
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
    if (!workflow.caseUnlocked) {
      setError(workflow.caseHint ?? "Complete Boards first.");
      return;
    }
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
    // Display the joined shell while fresh native model checks continue.
    for (const action of design.mode === "generated" ? ["preview_shape", "preview"] : ["preview"]) {
      setBusy(action === "preview_shape" ? "Creating case shape…" : "Checking models & fit…");
      const r = await call(action, { design });
      if (!mounted.current) return;
      if (action !== "preview" || design.mode !== "generated") framed.current = false;
      setPreview(r);
      setReport(r.report ?? null);
      setFitError("");
      setFitState(r.verificationPending ? "Checking models & fit…" : "Fit checked with preview");
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
              selectable: true,
              transformable: false,
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
      setTransparent(false);
      setSelectedBoard(null);
      setSelectedCase("@case-base.stl");
      setShowSpace(false);
      setStep("Review");
    }
  }
  async function makePreview(choice = layoutChoice, confirmBoards = false) {
    if (!design) return;
    if (!workflow.caseUnlocked && !(confirmBoards && workflow.canContinue))
      throw new Error(workflow.caseHint ?? "Choose boards first.");
    previewStart.current ??= {
      design: structuredClone(design),
      layout: layoutChoice,
      confirmed: confirmedSelection,
    };
    if (confirmBoards)
      setConfirmedSelection(enclosureSelectionKey(design.boards.map((b) => b.path)));
    if (design.mode === "generated" && choice !== "keep") {
      await autoArrange(false, true, choice);
      return;
    }
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
  function continueFromBoards(create = false) {
    if (!design || !workflow.canContinue || actionsDisabled || pcbModels.loading) return;
    setConfirmedSelection(enclosureSelectionKey(design.boards.map((b) => b.path)));
    setStep("Start");
    if (create && design.mode === "generated")
      void run("Reading boards…", () => autoArrange(false, true, "compact"));
  }
  async function autoArrange(
    resize = false,
    previewAfter = false,
    goal: EnclosureLayoutGoal = "compact",
  ) {
    if (!design) return;
    if (previewAfter)
      previewStart.current ??= {
        design: structuredClone(design),
        layout: layoutChoice,
        confirmed: confirmedSelection,
      };
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
    setBusy("Arranging boards…");
    const [choice] = await compareLayouts(input, boards, goal);
    if (!mounted.current) return;
    if (choice?.error?.startsWith("No collision-free") && input.layoutLimit)
      throw new Error(
        `Could not find a layout within your ${input.layoutLimit.width} × ${input.layoutLimit.depth} mm case limit. Your layout is unchanged. ${design.mode === "generated" ? "Use Resize case to fit for a larger new case, or review your boards and constraints." : "Review your boards and constraints, or choose New case to create a larger enclosure."}`,
      );
    if (!choice?.proposal)
      throw new Error(choice?.error ?? "Could not arrange these boards. Your layout is unchanged.");
    const arranged = previewAfter
      ? prepareEnclosurePreview(choice.proposal.design, boards, "keep")
      : choice.proposal.design;
    framed.current = false;
    edit(arranged, resize ? "Resize case and arrange boards" : "Auto arrange boards");
    setLayoutChoice("keep");
    selectBoard(null);
    setShowSpace(true);
    const review = choice.proposal.unresolved.length;
    const space = choice.proposal.design.space;
    setNotice(
      `Arranged ${design.boards.length} board${design.boards.length === 1 ? "" : "s"}. ` +
        (resize
          ? `Case sized to ${space.width} × ${space.depth} × ${space.height} mm inside. Previous size limit removed. `
          : "") +
        (review ? `${review} port connection${review === 1 ? "" : "s"} need review. ` : "") +
        "Preview to check the fit. Undo restores your previous layout.",
    );
    if (previewAfter) {
      setBusy("Making your case…");
      try {
        await showPreview(arranged);
      } catch (e) {
        throw new Error(
          `Boards arranged, but the preview could not finish. ${enclosureErrorMessage(e)} Undo is available.`,
        );
      }
    }
  }
  function navigateIssue(
    destination: "Start" | "Space" | "PCB",
    code: string,
    issue?: MechanicalFitIssue,
  ) {
    setReviewOpen(false);
    setAdvanced(true);
    const path = issue && fitIssueBoardPath(issue.message, design?.boards.map((b) => b.path) ?? []);
    const route = enclosureIssueRoute(code);
    if (!route) {
      setStep(destination === "PCB" ? "PCB" : "Start");
      return;
    }
    setStep(route.step);
    if (route.disclosure === "case") setCaseDetails(true);
    if (route.disclosure === "layout") setLayoutDetails(true);
    if (route.disclosure === "size") setCustomSize(true);
    let notice = "";
    if (route.target === "placement") {
      setStep("PCB");
      if (path) {
        selectBoard(path);
        setPlacementMode("translate");
      } else if (!selectedBoard) {
        setStep("PCB");
        setManualPlacement(true);
      }
      notice =
        "Move the highlighted board, or choose Auto arrange in Case. Preview again after making changes.";
    }
    if (code === "case-size-limit") {
      notice =
        "Auto arrange to fit your print area, or change the size limit below. Screw mounts count toward the outside size.";
    }
    setIssueControl({ target: route.target, boardPath: path ?? null, notice });
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
  async function build(downloadFiles = false) {
    if (!preview?.revision) return;
    await save(design);
    if (!mounted.current) return;
    const r = await call("build", { design, expectedRevision: preview.revision });
    if (!mounted.current) return;
    setArchive(r.archive ?? null);
    previewStart.current = null;
    setNotice("Your case and board files are ready to download.");
    if (downloadFiles && r.archive) await download(r.archive);
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
  const workflow = enclosureWorkflow({
    paths: design?.boards.map((b) => b.path) ?? [],
    readyPaths: (design?.boards ?? [])
      .filter((b) => {
        const f = featuresFor(b.path);
        return (
          f &&
          Number.isFinite(f.outline.widthMm) &&
          f.outline.widthMm > 0 &&
          Number.isFinite(f.outline.heightMm) &&
          f.outline.heightMm > 0
        );
      })
      .map((b) => b.path),
    confirmedSelection,
    hasPreview: !!preview,
    recovering: !!pendingRecovery,
  });
  // Restored views and changes to earlier choices cannot bypass the sequence.
  useEffect(() => {
    if (!design || busy || pendingRecovery) return;
    const selectionChanged =
      !design.boards.length ||
      confirmedSelection !== enclosureSelectionKey(design.boards.map((b) => b.path));
    if (step !== "PCB" && selectionChanged) setStep("PCB");
    else if (step === "Review" && !preview) setStep("Start");
  }, [design, busy, pendingRecovery, step, confirmedSelection, preview]);
  const exportReadiness = enclosureReadiness(!!preview, report, pcbModels.loading);
  const reviewCount = (report ? fitProblemCount(report) : 0) + (fitError ? 1 : 0);
  const stepNeedsAttention =
    !!error || !!fitError || (step === "Review" && report?.status === "blocked");
  const modelNeedsAttention =
    !!pcbModels.error ||
    !!pcbModels.setupError ||
    !!pcbModels.readiness?.needsSetup ||
    (!pcbModels.loading && Object.keys(pcbModels.models).length < pcbModels.requested);
  const currentPlacement = design?.boards.find((b) => b.path === selectedBoard);
  const currentFeatures = selectedBoard ? featuresFor(selectedBoard) : null;
  const currentPose =
    currentPlacement && currentFeatures
      ? enclosureBoardPose(currentPlacement, currentFeatures.outline)
      : null;
  const reviewItems = useMemo(() => {
    if (!design || !report || !focusedIssue) return [];
    const boards = mountingBoards();
    const issue = report.issues.find(
      (candidate) =>
        candidate === focusedIssue ||
        (candidate.code === focusedIssue.code &&
          candidate.severity === focusedIssue.severity &&
          candidate.message === focusedIssue.message),
    );
    if (!issue) return [];
    const issueIndex = report.issues.indexOf(issue);
    return enclosureReviewTargets(issue, design, boards).map((target, targetIndex) => ({
      id: `${issueIndex}:${targetIndex}`,
      issue,
      target,
      label: `${fitProblemTitle(issue)}${target.reference ? ` · ${target.reference}` : ""}`,
    }));
  }, [report, design, fitBoards, preview, board, focusedIssue]);
  const reviewItemIndex = Math.max(
    0,
    reviewItems.findIndex(
      ({ target }) =>
        target.reference === focusedTarget?.reference &&
        target.boardPath === focusedTarget?.boardPath &&
        target.point.every((value, index) => value === focusedTarget?.point[index]),
    ),
  );
  const activeReviewItems = reviewOpen
    ? reviewItems.slice(reviewItemIndex, reviewItemIndex + 1)
    : [];
  updateAnnotation.current = () => {
    const canvas = host.current;
    const bounds = canvas?.getBoundingClientRect();
    const obstacles = bounds
      ? Array.from(
          canvas!.parentElement!.querySelectorAll<HTMLElement>(
            ".fd-enclosure-card, .fd-enclosure-board-choice, .fd-enclosure-review, .fd-enclosure-selection, .fd-enclosure-apply, .fd-enclosure-viewbar, .fd-enclosure-review-toggle, .fd-enclosure-view-menu, .fd-enclosure-measurement",
          ),
        )
          .filter((el) => el.offsetWidth && el.offsetHeight)
          .map((el) => {
            const rect = el.getBoundingClientRect();
            return {
              x: rect.x - bounds.x,
              y: rect.y - bounds.y,
              width: rect.width,
              height: rect.height,
            };
          })
      : [];
    const next =
      canvas && !advanced && !connectionsOpen && !exportOpen
        ? placeReviewCallouts({
            items: activeReviewItems.flatMap(({ id, target }) => {
              const point = scene.current?.projectPoint(...target.point);
              return point
                ? [
                    {
                      id,
                      target: { x: Math.round(point.x), y: Math.round(point.y) },
                      label: calloutSizes.current.get(id) ?? { width: 220, height: 44 },
                    },
                  ]
                : [];
            }),
            viewport: { width: canvas.clientWidth, height: canvas.clientHeight },
            obstacles,
          })
        : [];
    setAnnotations((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
  };
  useEffect(() => {
    updateAnnotation.current();
  }, [
    reviewItems,
    focusedTarget,
    preview,
    reviewOpen,
    exportOpen,
    advanced,
    connectionsOpen,
    choosingBoards,
    fitBoards,
    viewMenu,
    measured,
  ]);
  useEffect(() => {
    if (!callouts.current) return;
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset["reviewId"];
        if (!id) continue;
        const rect = entry.target.getBoundingClientRect();
        // Removed/offscreen labels can deliver a final zero-size observation.
        // Keep their last usable size so they reappear when the camera returns.
        if (!entry.target.isConnected || !rect.width || !rect.height) continue;
        const size = { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
        const previous = calloutSizes.current.get(id);
        if (previous?.width === size.width && previous.height === size.height) continue;
        calloutSizes.current.set(id, size);
        changed = true;
      }
      if (changed) updateAnnotation.current();
    });
    callouts.current
      .querySelectorAll(".fd-enclosure-callout")
      .forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [annotations.map((a) => a.id).join(",")]);
  useEffect(() => {
    if (!active || advanced) return;
    const update = (autoFit = true) =>
      scene.current?.setViewportInsets(
        {
          left: reviewOpen || (host.current?.clientWidth ?? 1000) < 650 ? 0 : 300,
          right: reviewOpen ? 390 : 20,
          top: !reviewOpen && (host.current?.clientWidth ?? 1000) < 650 ? 330 : 30,
          bottom: 76,
        },
        autoFit,
      );
    update();
    const observer = new ResizeObserver(() => update(false));
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, [active, advanced, reviewOpen]);
  useEffect(() => {
    if (advanced) scene.current?.setViewportInsets({ left: 0, right: 0, top: 0, bottom: 0 });
  }, [advanced]);
  useEffect(() => {
    if (!focusedIssue || (!advanced && !reviewOpen)) return;
    const target = focusedTarget ?? reviewTarget(focusedIssue);
    if (!target) return;
    // Keep the board around a small connector visible, so the marker has useful context.
    if (target.modelId && target.kind !== "regions") scene.current?.focusModel(target.modelId);
    else scene.current?.focusFitRegions(target.regions);
  }, [focusedIssue, focusedTarget, reviewOpen, advanced]);
  return (
    <section
      className="fd-case-workflow fd-case-compact"
      data-advanced={advanced}
      data-connections={connectionsOpen}
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
      {!advanced && !connectionsOpen && !reviewOpen && (
        <aside className="fd-enclosure-card" aria-label="Generate enclosure">
          <header>
            <h2>{design?.mode === "imported" ? "Fit existing case" : "Generate enclosure"}</h2>
            <button
              className="fd-enclosure-menu-trigger"
              aria-label="View options"
              aria-expanded={viewMenu}
              onClick={() => setViewMenu(!viewMenu)}
            >
              •••
            </button>
          </header>
          {design ? (
            <>
              <fieldset disabled={actionsDisabled}>
                <label className="fd-enclosure-around">
                  Around
                  <select
                    aria-label="Boards for enclosure"
                    value={design.boards.length === 1 ? design.boards[0]!.path : "selected"}
                    onChange={(e) => {
                      if (e.target.value === "choose") {
                        setChoosingBoards(true);
                        return;
                      }
                      edit(
                        { ...selectEnclosureBoards(design, [e.target.value]), confirmed: false },
                        "Choose board",
                      );
                      setLayoutChoice("compact");
                    }}
                  >
                    {design.boards.length !== 1 && (
                      <option value="selected" disabled>
                        {design.boards.length
                          ? `${design.boards.length} selected boards`
                          : "Choose boards…"}
                      </option>
                    )}
                    {enclosureSourceBoards(
                      files,
                      design.boards.map((b) => b.path),
                    ).map((path) => (
                      <option key={path} value={path}>
                        {enclosureFileLabel(path)}
                      </option>
                    ))}
                    <option value="choose">Choose multiple boards…</option>
                  </select>
                </label>
                {(["clearance", "wall"] as const).map((key) => (
                  <NumberField
                    key={key}
                    label={key === "wall" ? "Wall" : "Clearance"}
                    value={design.space[key]}
                    min={key === "wall" ? 0.5 : 0}
                    max={20}
                    onChange={(value) => {
                      edit(
                        { ...design, confirmed: false, space: { ...design.space, [key]: value } },
                        "Case clearance and wall",
                      );
                      if (design.mode === "generated") setLayoutChoice("compact");
                    }}
                  />
                ))}
              </fieldset>
              <button
                className="fd-enclosure-more"
                disabled={actionsDisabled}
                onClick={() => {
                  if (workflow.canContinue)
                    setConfirmedSelection(enclosureSelectionKey(design.boards.map((b) => b.path)));
                  setStep(workflow.canContinue ? "Start" : "PCB");
                  setAdvanced(true);
                }}
              >
                <span aria-hidden="true">›</span> More options
              </button>
              {error && (
                <p className="fd-enclosure-error" role="alert">
                  {error}
                </p>
              )}
              {recoveryWarning && (
                <p className="fd-enclosure-error" role="status">
                  {recoveryWarning}
                </p>
              )}
              <button
                className="fd-mechanical-primary fd-enclosure-preview"
                disabled={actionsDisabled || pcbModels.loading || !workflow.canContinue}
                onClick={() => {
                  if (
                    design.mode === "imported" &&
                    (!design.confirmed || !design.source?.path || !capabilities.cad)
                  ) {
                    setConfirmedSelection(enclosureSelectionKey(design.boards.map((b) => b.path)));
                    setStep("Start");
                    setAdvanced(true);
                    return;
                  }
                  previewStart.current ??= {
                    design: structuredClone(design),
                    layout: layoutChoice,
                    confirmed: confirmedSelection,
                  };
                  setReviewOpen(false);
                  void run("Preparing preview…", () => makePreview(layoutChoice, true));
                }}
              >
                {busy
                  ? "Creating preview…"
                  : pcbModels.loading
                    ? "Loading boards…"
                    : preview
                      ? "Update preview"
                      : "Preview"}
              </button>
            </>
          ) : (
            <p role="status">Loading boards…</p>
          )}
        </aside>
      )}
      {!advanced && connectionsOpen && design && (
        <EnclosureConnections
          design={design}
          boards={mountingBoards()}
          disabled={actionsDisabled}
          onChange={(next) => edit(next, "Edit connections")}
          onClose={() => {
            setConnectionsOpen(false);
            setShowPlugs(false);
          }}
        />
      )}
      {!advanced && choosingBoards && design && (
        <aside className="fd-enclosure-board-choice" aria-label="Choose enclosure boards">
          <EnclosureBoardPicker
            files={enclosureSourceBoards(
              files,
              design.boards.map((b) => b.path),
            )}
            selected={design.boards.map((b) => b.path)}
            onChange={(paths) => {
              edit({ ...selectEnclosureBoards(design, paths), confirmed: false }, "Choose boards");
              if (design.mode === "generated") setLayoutChoice("compact");
            }}
          />
          <button className="fd-mechanical-primary" onClick={() => setChoosingBoards(false)}>
            Done
          </button>
        </aside>
      )}
      {!advanced && currentPlacement && currentFeatures && (
        <div className="fd-enclosure-selection" aria-label="Selected board">
          <div>
            <strong title={currentPlacement.path}>
              {enclosureFileLabel(currentPlacement.path)}
            </strong>
            <small>
              {Number(currentFeatures.outline.widthMm.toFixed(1))} ×{" "}
              {Number(currentFeatures.outline.heightMm.toFixed(1))} × {currentFeatures.thicknessMm}{" "}
              mm
            </small>
          </div>
          {(
            [
              ["translate", "Move"],
              ["rotate", "Rotate"],
              ["measure", "Measure"],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              disabled={actionsDisabled || (mode !== "measure" && !!currentPlacement.locked)}
              aria-pressed={placementMode === mode}
              onClick={() => setPlacementMode(placementMode === mode ? "orbit" : mode)}
            >
              {label}
            </button>
          ))}
          <button
            aria-label="Turn selected board 90 degrees"
            title="Turn 90°"
            disabled={actionsDisabled || !!currentPlacement.locked}
            onClick={() =>
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
            90°
          </button>
          <button aria-label="Clear board selection" onClick={() => selectBoard(null)}>
            ×
          </button>
        </div>
      )}
      {!advanced && (
        <>
          {viewMenu && (
            <aside className="fd-enclosure-view-menu" aria-label="View options">
              <MechanicalViewCube
                orientation={orientation}
                onView={(view) => scene.current?.view(view)}
              />
              <button aria-pressed={transparent} onClick={() => setTransparent(!transparent)}>
                See through
              </button>
              <button aria-pressed={!caseVisible} onClick={() => setCaseVisible(!caseVisible)}>
                {caseVisible ? "Hide case" : "Show case"}
              </button>
              {preview?.meshes?.lid && (
                <button aria-pressed={openLid} onClick={() => setOpenLid(!openLid)}>
                  {openLid ? "Close lid" : "Open lid"}
                </button>
              )}
              <button
                disabled={actionsDisabled || !history.current.undoLabel}
                onClick={() => restoreHistory()}
              >
                Undo
              </button>
              <button
                disabled={actionsDisabled || !history.current.redoLabel}
                onClick={() => restoreHistory(true)}
              >
                Redo
              </button>
            </aside>
          )}
          <div className="fd-enclosure-viewbar" aria-label="View controls">
            <button onClick={() => scene.current?.fit()}>
              <MechanicalIcon name="fit" /> Fit
            </button>
            <button aria-label="Zoom out" onClick={() => scene.current?.zoom(1.2)}>
              −
            </button>
            <output aria-label="Zoom level">{zoom}%</output>
            <button aria-label="Zoom in" onClick={() => scene.current?.zoom(1 / 1.2)}>
              +
            </button>
          </div>
          {placementMode === "measure" && (
            <div className="fd-enclosure-measurement" role="status">
              {measured === null
                ? "Select two points to measure"
                : `${Number(measured.toFixed(2))} mm`}
              <button onClick={() => setPlacementMode("orbit")} aria-label="Finish measurement">
                ×
              </button>
            </div>
          )}
          {!!annotations.length && (
            <div
              className="fd-enclosure-review-callouts"
              ref={callouts}
              role="group"
              aria-label="Part reviews"
            >
              <svg className="fd-enclosure-review-leader" aria-hidden="true">
                {annotations.map((annotation) => {
                  const item = reviewItems.find((item) => item.id === annotation.id);
                  return item ? (
                    <g
                      key={item.id}
                      data-review-id={item.id}
                      data-blocked={item.issue.severity === "error"}
                    >
                      <line
                        x1={annotation.target.x}
                        y1={annotation.target.y}
                        x2={annotation.anchor.x}
                        y2={annotation.anchor.y}
                      />
                      <circle cx={annotation.target.x} cy={annotation.target.y} r={4} />
                    </g>
                  ) : null;
                })}
              </svg>
              {annotations.map((annotation) => {
                const item = reviewItems.find((item) => item.id === annotation.id);
                return item ? (
                  <button
                    key={item.id}
                    className="fd-enclosure-callout"
                    data-review-id={item.id}
                    data-blocked={item.issue.severity === "error"}
                    aria-label={`${item.label}${item.target.boardPath ? ` — ${enclosureFileLabel(item.target.boardPath)}` : ""}`}
                    style={{
                      left: annotation.label.x,
                      top: annotation.label.y,
                      width: annotation.label.width,
                    }}
                    title={item.issue.message}
                    onClick={() => {
                      setReviewOpen(true);
                      showIssue(item.issue, item.target);
                    }}
                  >
                    <span aria-hidden="true">⚠</span>
                    {item.label}
                  </button>
                ) : null;
              })}
            </div>
          )}
          {report?.issues.length || fitError || pcbModels.error ? (
            <button
              className="fd-enclosure-review-toggle"
              data-blocked={report?.status === "blocked"}
              aria-expanded={reviewOpen}
              aria-label={
                reviewCount
                  ? `Review updates: ${reviewCount} ${reviewCount === 1 ? "problem" : "problems"}`
                  : "Review updates"
              }
              onClick={() => {
                if (reviewOpen) closeReview();
                else setReviewOpen(true);
                setExportOpen(false);
              }}
            >
              <span aria-hidden="true">⚠</span> Review updates
              {!!reviewCount && (
                <b className="fd-enclosure-review-count" aria-hidden="true">
                  {reviewCount}
                </b>
              )}
            </button>
          ) : null}
          {exportOpen && (
            <aside className="fd-enclosure-review fd-enclosure-export" aria-label="Export design">
              <header>
                <h2>Export design</h2>
                <button aria-label="Close export" onClick={() => setExportOpen(false)}>
                  ×
                </button>
              </header>
              <p>
                {archive
                  ? "Your matched enclosure and board files are ready."
                  : preview
                    ? "Apply this preview to prepare your matched design files."
                    : "Create a preview to export your enclosure and boards together."}
              </p>
              <div className="fd-enclosure-export-formats">
                <span>
                  STL<span>3D printing</span>
                </span>
                <span>
                  STEP<span>CAD editing</span>
                </span>
                <span>
                  PCB<span>Board files</span>
                </span>
              </div>
              {preview && !exportReadiness.canExport && (
                <p role="status">{busy || "Review the fit checks before exporting."}</p>
              )}
              <button
                className="fd-mechanical-primary"
                disabled={
                  actionsDisabled ||
                  (!!preview && (!exportReadiness.canExport || !!preview.verificationPending))
                }
                onClick={() => {
                  if (!preview) {
                    setExportOpen(false);
                    setConnectionsOpen(false);
                    return;
                  }
                  void run("Preparing download…", async () => {
                    if (archive) await download(archive);
                    else await build(true);
                  });
                }}
              >
                {preview ? (archive ? "Download files" : "Apply & download") : "Return to preview"}
              </button>
            </aside>
          )}
          {reviewOpen && (
            <aside className="fd-enclosure-review" aria-label="Review updates">
              <header>
                <h2>Review updates</h2>
                <button aria-label="Close review updates" onClick={closeReview}>
                  ×
                </button>
              </header>

              {fitError && (
                <FitProblem title="Fit check could not finish" blocked>
                  <p role="alert">{fitError}</p>
                </FitProblem>
              )}
              {report && (
                <EnclosureFitReview
                  report={report}
                  readiness={exportReadiness}
                  onNavigate={navigateIssue}
                  onShowIssue={showIssue}
                  onClearIssue={clearIssue}
                  partPicker={
                    reviewItems.length > 1 ? (
                      <label className="fd-enclosure-review-part">
                        Part
                        <select
                          aria-label="Part to review"
                          value={reviewItemIndex}
                          onChange={(event) => {
                            const item = reviewItems[Number(event.target.value)];
                            if (item) showIssue(item.issue, item.target);
                          }}
                        >
                          {reviewItems.map((item, index) => (
                            <option key={item.id} value={index}>
                              {item.target.reference ??
                                item.target.regions[0]?.name ??
                                (item.target.boardPath
                                  ? enclosureFileLabel(item.target.boardPath)
                                  : `Part ${index + 1}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null
                  }
                  canShowIssue={(issue) => !!reviewTarget(issue)}
                  focusedIssue={focusedIssue}
                />
              )}
            </aside>
          )}
          {preview && (
            <div className="fd-enclosure-apply" aria-label="Preview actions">
              <span role="status">
                {busy
                  ? "Checking…"
                  : archive
                    ? "Applied"
                    : report?.status === "blocked"
                      ? "Fit needs attention"
                      : "Preview · not applied"}
              </span>
              {!archive && (
                <button
                  disabled={actionsDisabled}
                  onClick={() =>
                    void run("Restoring layout…", async () => {
                      const previous = previewStart.current;
                      if (previous) {
                        edit(previous.design, "Cancel preview");
                        applyDraft(previous.design);
                        setLayoutChoice(previous.layout);
                        setConfirmedSelection(previous.confirmed);
                      } else {
                        setPreview(null);
                        setModelSources([]);
                        setArchive(null);
                      }
                      previewStart.current = null;
                      setReviewOpen(false);
                      setStep("Start");
                    })
                  }
                >
                  Cancel
                </button>
              )}
              <button
                className="fd-mechanical-primary"
                disabled={
                  actionsDisabled || !exportReadiness.canExport || !!preview.verificationPending
                }
                onClick={() =>
                  void run(archive ? "Preparing download…" : "Applying enclosure…", async () => {
                    if (archive) await download(archive);
                    else {
                      await build();
                      previewStart.current = null;
                    }
                  })
                }
              >
                {archive ? "Download" : "Apply"}
              </button>
            </div>
          )}
        </>
      )}
      <aside
        hidden={!advanced}
        className="fd-case-panel fd-enclosure-options"
        data-step-attention={stepNeedsAttention}
        aria-label="Enclosure options"
      >
        <header>
          <h2>Enclosure options</h2>
          <div className="fd-enclosure-options-actions">
            {dirty && !preview && (
              <button
                className="fd-case-save-draft"
                disabled={actionsDisabled}
                onClick={() => void run("Saving settings…", save)}
              >
                Save draft
              </button>
            )}
            <button
              className="fd-enclosure-options-done"
              disabled={!!pendingRecovery}
              onClick={() => setAdvanced(false)}
            >
              Done
            </button>
          </div>
        </header>
        <nav aria-label="Enclosure workflow">
          {steps.map((s) => {
            const locked =
              s === "Start"
                ? !workflow.caseUnlocked
                : s === "Review"
                  ? !workflow.previewUnlocked
                  : false;
            const complete =
              s === "PCB"
                ? workflow.boardsComplete
                : s === "Start"
                  ? workflow.previewUnlocked
                  : false;
            const hint =
              s === "Start" ? workflow.caseHint : s === "Review" ? workflow.previewHint : null;
            const state = locked
              ? "locked"
              : s === step
                ? stepNeedsAttention
                  ? "attention"
                  : "current"
                : complete
                  ? "complete"
                  : "available";
            const stateLabel = {
              locked: "Locked",
              attention: "Needs attention",
              current: "Current",
              complete: "Complete",
              available: "Ready",
            }[state];
            return (
              <button
                key={s}
                data-step-state={state}
                aria-label={`${stepLabels[s]} — ${stateLabel}`}
                aria-current={step === s ? "step" : undefined}
                disabled={actionsDisabled || locked}
                title={locked ? (hint ?? undefined) : undefined}
                onClick={() => setStep(s)}
              >
                <span className="fd-case-step-name">
                  {(locked || complete) && <MechanicalIcon name={locked ? "lock" : "check"} />}
                  {stepLabels[s]}
                </span>
              </button>
            );
          })}
        </nav>
        <div className="fd-case-body" ref={body}>
          {modelNeedsAttention && <PcbModelHealth {...pcbModels} />}
          {step === "PCB" && !workflow.canContinue && (
            <p className="fd-enclosure-options-hint" role="status">
              {workflow.boardsHint}
            </p>
          )}
          {fitError && step !== "Review" && (
            <p className="fd-case-message is-error" role="alert">
              {fitError}
            </p>
          )}
          {step === "PCB" && (
            <EnclosureBoardDimensions
              paths={design?.boards.map((b) => b.path) ?? []}
              selected={selectedBoard}
              features={currentFeatures}
              disabled={actionsDisabled}
              onSelect={selectBoard}
              onFocus={() => selectedBoard && scene.current?.focusModel(`@fit-${selectedBoard}`)}
            />
          )}
          {step === "PCB" && selectedBoard && !pcbModels.models[selectedBoard] && (
            <p role="status" className="fd-mechanical-note">
              {pcbModels.loading
                ? "Loading this board’s 3D model… Its bounds are shown temporarily."
                : "This board’s 3D model is unavailable. The amber shape shows estimated bounds only. Open 3D details below for the cause and retry."}
            </p>
          )}
          {step === "PCB" && currentPlacement && (
            <section
              className="fd-case-placement"
              aria-label="Selected board controls"
              data-enclosure-control="placement"
            >
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
            <fieldset
              disabled={!!busy || !!pendingRecovery || (step !== "PCB" && !workflow.caseUnlocked)}
              className="fd-case-fields"
            >
              {step === "Start" && (
                <>
                  <label className="fd-enclosure-option-row">
                    Case type
                    <select
                      aria-label="Case type"
                      value={design.mode}
                      onChange={(e) => {
                        if (e.target.value === "generated") {
                          edit({ ...design, mode: "generated", confirmed: false });
                          setLayoutChoice("compact");
                        } else {
                          // Generated hardware is unavailable when fitting an existing case.
                          const { closure: _closure, holders: _holders, ...rest } = design;
                          edit({ ...rest, mode: "imported", confirmed: false });
                        }
                      }}
                    >
                      <option value="generated">New case</option>
                      <option value="imported">Existing case</option>
                    </select>
                  </label>
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
                      <label className="fd-case-layout-choice fd-enclosure-option-row">
                        Board layout
                        <select
                          value={layoutChoice}
                          onChange={(e) => {
                            setLayoutChoice(e.target.value as EnclosureLayoutGoal | "keep");

                            setPreview(null);
                            setArchive(null);
                          }}
                        >
                          <option value="compact">Auto arrange · compact case</option>
                          <option value="assembly">Auto arrange · more room</option>
                          <option value="ports">Auto arrange · ports together</option>
                          <option value="keep">Keep my board positions</option>
                        </select>
                      </label>
                      <p className="fd-case-hint">
                        {layoutChoice === "ports"
                          ? "Group detected ports on fewer sides of the case."
                          : layoutChoice === "keep"
                            ? `Current inside size: ${design.space.width} × ${design.space.depth} × ${design.space.height} mm.`
                            : "No measurements needed to start. Locks, fixed parts and custom openings are respected."}
                      </p>
                      <details
                        open={customSize}
                        data-enclosure-control="dimensions"
                        onToggle={(e) => setCustomSize(e.currentTarget.open)}
                        className="fd-case-advanced"
                      >
                        <summary>
                          <span>Size & thickness</span>
                          <small>{layoutChoice === "keep" ? "Custom" : "Automatic"}</small>
                        </summary>
                        <p>Set an inside size, or let the case fit your boards.</p>
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
                        {design.layoutLimit && (
                          <div className="fd-case-resize-option">
                            <p>
                              Outside size limit: {design.layoutLimit.width} ×{" "}
                              {design.layoutLimit.depth} mm.
                            </p>
                            <button
                              disabled={
                                actionsDisabled || pcbModels.loading || !design.boards.length
                              }
                              onClick={() =>
                                void run("Reading boards…", () => autoArrange(true, true))
                              }
                            >
                              Resize case to fit
                            </button>
                            <small>
                              Removes this size limit. Fixed boards and obstacles stay protected.
                            </small>
                          </div>
                        )}
                        <div className="fd-case-grid">
                          {field("width", "Inside width")}
                          {field("depth", "Inside depth")}
                          {field("height", "Inside height")}
                        </div>
                        <details>
                          <summary>Thickness & origin</summary>
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
                  <EnclosureHardwarePanel design={design} onChange={edit} />
                  {design.mode === "imported" && (
                    <>
                      <h3>Inside size</h3>
                      <p>
                        For an existing case, measure the empty space inside. Sizes are in
                        millimetres.
                      </p>
                      <div className="fd-case-grid" data-enclosure-control="dimensions">
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
                  className="fd-case-advanced"
                  open={caseDetails}
                  onToggle={(e) => setCaseDetails(e.currentTarget.open)}
                >
                  <summary>Supports & openings</summary>
                  <p>Make room for fixed parts, add board supports or adjust cutouts.</p>
                  {field("clearance", "Minimum clearance", 0)}
                  <details data-enclosure-control="obstacles">
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
                  <details data-enclosure-control="mounts">
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
                  <details data-enclosure-control="openings">
                    <summary>Connector openings · {design.openings.length}</summary>
                    <p className="fd-case-help">
                      Automatic openings follow their boards. Custom openings keep their board in
                      place during auto arrange.
                    </p>
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
                                    ? {
                                        ...p,
                                        followBoard: false,
                                        shape: e.target.value as "rectangle" | "rounded",
                                      }
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
                                  j === i
                                    ? {
                                        ...p,
                                        followBoard: false,
                                        wall: e.target.value as typeof o.wall,
                                      }
                                    : p,
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
                                    j === i ? { ...p, followBoard: false, [k]: v } : p,
                                  ),
                                })
                              }
                            />
                          ))}
                        </div>
                        {o.boardPath && o.ref && (
                          <button
                            disabled={actionsDisabled}
                            onClick={() =>
                              void run("Updating port opening…", async () => {
                                const checked = await call("check", {
                                  design: { ...design, detailedFit: false, assemblyCheck: false },
                                });
                                if (!mounted.current) return;
                                setFitBoards(checked.boards);
                                edit(
                                  refreshEnclosureOpenings(
                                    {
                                      ...design,
                                      openings: design.openings.map((p, j) =>
                                        j === i ? { ...p, followBoard: true } : p,
                                      ),
                                    },
                                    checked.boards ?? [],
                                  ),
                                  "Match opening to port",
                                );
                                setNotice(
                                  "Opening matched to its port. Make a new preview to check the fit.",
                                );
                              })
                            }
                          >
                            Match opening to port
                          </button>
                        )}
                        <button
                          onClick={() =>
                            edit({
                              ...design,
                              openings: design.openings.filter((_, j) => j !== i),
                            })
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
                  className="fd-case-advanced"
                  open={layoutDetails}
                  onToggle={(e) => setLayoutDetails(e.currentTarget.open)}
                >
                  <summary>Ports & cables</summary>
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
                      edit(
                        { ...selectEnclosureBoards(design, paths), confirmed: false },
                        "Choose boards",
                      );
                      if (design.mode === "generated") setLayoutChoice("compact");
                    }}
                  />
                  <details
                    className="fd-case-advanced"
                    data-enclosure-control="placement"
                    open={manualPlacement}
                    onToggle={(e) => setManualPlacement(e.currentTarget.open)}
                  >
                    <summary>Board positions & PCB editing</summary>
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
                  {report?.outsideSize && (
                    <p className="fd-case-hint">
                      Outside: {Number(report.outsideSize.width.toFixed(2))} ×{" "}
                      {Number(report.outsideSize.depth.toFixed(2))} ×{" "}
                      {Number(report.outsideSize.height.toFixed(2))} mm
                    </p>
                  )}
                  {fitError && (
                    <FitProblem title="Fit check could not finish" blocked>
                      <p role="alert">{fitError}</p>
                    </FitProblem>
                  )}
                  {report && (
                    <EnclosureFitReview
                      report={report}
                      readiness={exportReadiness}
                      onNavigate={navigateIssue}
                      onShowIssue={showIssue}
                      onClearIssue={clearIssue}
                      canShowIssue={(issue) => !!reviewTarget(issue)}
                      focusedIssue={focusedIssue}
                    />
                  )}
                  {!preview && (
                    <p className="fd-case-hint">
                      Make a preview to see your case and check the fit.
                    </p>
                  )}
                  {design.mode === "imported" && !capabilities.cad && connectionCard("cad")}
                  <details className="fd-case-recheck">
                    <summary>Preview options</summary>
                    <div className="fd-case-preview-tools">
                      <button
                        aria-pressed={transparent}
                        onClick={() => setTransparent(!transparent)}
                      >
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
                      Check fit again
                    </button>
                    <p className="fd-case-fit-state" role="status">
                      {preview && !preview.verificationPending
                        ? "Fit checked with preview"
                        : fitState}
                    </p>
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
                  </details>
                </>
              )}
            </fieldset>
          )}
          {step !== "Review" && !!design?.boards.length && (
            <details className="fd-case-model-disclosure" data-enclosure-control="models">
              <summary>
                {pcbModels.loading
                  ? "Loading 3D models…"
                  : modelNeedsAttention ||
                      Object.values(pcbModels.models).some((m) => m.coverage.missing.length)
                    ? "3D models · needs review"
                    : "3D models & downloads"}
              </summary>
              {!modelNeedsAttention && <PcbModelHealth {...pcbModels} />}
              <PcbModelStatus {...pcbModels} />
            </details>
          )}
        </div>
        <footer>
          <div className="fd-case-footer-status">
            <span role="status">
              {busy ||
                (pcbModels.loading ? "Reading board shapes…" : "") ||
                (preview
                  ? exportReadiness.title
                  : design?.mode === "imported" && !capabilities.cad
                    ? cadRuntime?.status === "unsupported"
                      ? "Imported-case editing unavailable here"
                      : "Connect CAD to preview this case"
                    : design?.confirmed
                      ? "Ready to preview"
                      : design?.mode === "generated"
                        ? layoutChoice === "keep"
                          ? "Using your current layout"
                          : "We’ll size the case for you"
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
            {step === "PCB" && design?.mode === "generated" && !design.confirmed && (
              <button
                className="fd-case-back"
                disabled={actionsDisabled || !workflow.canContinue || pcbModels.loading}
                onClick={() => continueFromBoards()}
              >
                Case options
              </button>
            )}
            {step === "PCB" ? (
              <button
                className="fd-mechanical-primary"
                disabled={actionsDisabled || !workflow.canContinue || pcbModels.loading}
                onClick={() =>
                  continueFromBoards(design?.mode === "generated" && !design.confirmed)
                }
              >
                {design?.mode === "generated" && !design.confirmed
                  ? "Create case"
                  : "Continue to case"}
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
                onClick={() => void run("Reading boards…", makePreview)}
              >
                {busy ||
                  (pcbModels.loading
                    ? "Reading boards…"
                    : design?.mode === "generated" && layoutChoice !== "keep"
                      ? "Arrange & fit case"
                      : "Preview case")}
              </button>
            ) : archive ? (
              <button
                className="fd-mechanical-primary"
                disabled={actionsDisabled}
                onClick={() => void run("Preparing download…", () => download(archive))}
              >
                Download files
              </button>
            ) : preview && !preview.verificationPending ? (
              <button
                className="fd-mechanical-primary"
                disabled={actionsDisabled || !exportReadiness.canExport}
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
                onClick={() => void run("Reading boards…", makePreview)}
              >
                {busy ||
                  (pcbModels.loading
                    ? "Reading boards…"
                    : design?.mode === "generated" && layoutChoice !== "keep"
                      ? "Arrange & fit case"
                      : "Preview case")}
              </button>
            )}
          </div>
        </footer>
      </aside>
      {advanced && (
        <div className="fd-case-hud" data-collapsed={!controlsExpanded}>
          <button
            className="fd-case-controls-toggle"
            aria-expanded={controlsExpanded}
            aria-controls={sceneToolsId}
            onClick={() => setControlsExpanded(!controlsExpanded)}
          >
            <span>View options</span>
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
                <button disabled={!workflow.previewUnlocked} onClick={() => setStep("Review")}>
                  Review fit issues
                </button>
              ) : null}
              {!showRisks && <small>Red highlights hidden</small>}
            </div>
          </div>
        </div>
      )}
      {advanced && (
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
      )}
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
