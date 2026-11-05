import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCoreClient, useProject, useBoardSources, sha256Blob, captureAssemblySourceSelection } from "@fabdesk/client-core";
import {
  createPlacementWorkingCopy, type PlacementCandidate, placementSourceTarget, placementSourceKey, placementSourceDraftPath, encodePlacementDraft, decodePlacementDraft,
  type PlacementSource,
  MAX_PLACEMENT_BYTES,
  clone,
  placementBoardFiles,
  placementDrafts,
  placementHistory,
  commitPlacement,
  undoPlacement,
  redoPlacement,
  expanded,
  moveParts,
  rotateParts,
  groupParts,
  ungroupParts,
  alignParts,
  setAnchor,
  validatePlacementSettings,
  type PlacementSession,
  type PlacementAnalysis,
  type PlacementHistory,
  type PlacementReview,
  type PlacementContext,
  type Point,
  loadPlacementExamples,
  saveAutosave,
  restorePlacement,
  DEVICE_PLACEMENT_RECOVERY,
  setPartValue,
  setAnchorOffset,
  swapPlacement,
} from "@fabdesk/client-core/placement";
import { useUiStore } from "../../stores/ui";
import { Button, Dialog, EmptyState, Input, Select, Spinner } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { PlacementCanvas } from "./PlacementCanvas";
import { placementJob } from "./placement-jobs";
import type { PlacementJob, PlacementResult } from "./placement.worker";
import "./placement.css";
import { FootprintLibrary, FootprintPicture, type FootprintChoice } from "./FootprintLibrary";
import { WorkspaceMenu } from "../../layout/WorkspaceMenu";
import { CanvasToolButton } from "../../components/CanvasToolButton";
import { askAboutSurface, useAssistantSurface } from "../../chat/useAssistantSurface";
import { takePlacementEntry } from "./placement-entry";
import { PlacementEnclosure } from "./PlacementEnclosure";

const fmt = (n: number) => Number(n.toFixed(2)).toString();
const EMPTY_ANALYSIS: PlacementAnalysis = { findings: [], guidelines: [], edges: [], length: 0 };

// The cache survives tab/project changes, so its close guard must have application lifetime too.
let closeGuardInstalled = false;
function installDraftCloseGuard() {
  if (closeGuardInstalled) return;
  closeGuardInstalled = true;
  window.addEventListener("beforeunload", (event) => {
    if (placementDrafts.hasUnsaved()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}

function NumberField({
  label,
  value,
  onChange,
  min = -10000,
  max = 10000,
  step = 0.25,
  disabled = false,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="fd-placement-field">
      <span>{label}</span>
      <input
        type="number"
        value={text}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          const n = Number(text);
          setText(String(value));
          // Step controls arrow increments, not the precision of a typed dimension or angle.
          if (
            text.trim() &&
            !e.target.validity.badInput &&
            Number.isFinite(n) &&
            n >= min &&
            n <= max &&
            n !== value
          )
            onChange(n);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </label>
  );
}

export function PlacementTab({ canvas = false }: { canvas?: boolean }) {
  const projectId = useUiStore((s) => s.activeProjectId);
  const sources = useBoardSources(projectId);
  const client = useCoreClient();
  const savedSelection = useUiStore(state => projectId ? state.assemblyBoardByProject[projectId] : undefined);
  const target = placementSourceTarget(sources.data, savedSelection);
  const sourcePath = target?.path;
  const baseline = useQuery({
    queryKey: ["placement-baseline", client.baseUrl, projectId, sourcePath, target?.sourceId],
    enabled: !!projectId && !!sourcePath && !sources.isFetching && !sources.isError,
    queryFn: async () => {
      const bytes = await client.readFileBlob(projectId!, sourcePath!);
      return { projectId: projectId!, path: sourcePath!, sha256: await sha256Blob(bytes), ...(target?.sourceId ? { sourceId: target.sourceId } : {}) };
    },
  });
  // Recheck bytes without replacing the query identity on every inspection timestamp.
  // A file-list refresh after Save/Export must not unmount the editor and lose its result.
  useEffect(() => { if (projectId && sourcePath && !sources.isFetching && !sources.isError) void baseline.refetch(); }, [projectId, sourcePath, target?.sourceId, sources.data?.observedAt, sources.isFetching, sources.isError]);
  if (!projectId)
    return (
      <EmptyState title="Arrange your board">
        <span>Choose a project to start placing components.</span>
      </EmptyState>
    );
  if (sources.isPending) return <EmptyState title="Checking board source"><Spinner /></EmptyState>;
  if (sources.isError || !sourcePath) return <EmptyState title={sources.isError ? "Board source unavailable" : "Choose a board for this draft"} action={<Button size="sm" onClick={() => useUiStore.getState().setWorkspaceArea("overview")}>Choose board in overview</Button>}>
    <p>Placement uses the selected board’s saved native source. Select an available board before opening its draft.</p>
  </EmptyState>;
  if (baseline.isError) return <EmptyState title="Choose a saved PCB first" action={<Button onClick={() => useUiStore.getState().setBoardTab("pcb")}>Back to PCB</Button>}>Placement needs this project’s active native PCB. Open or import it before creating a draft.</EmptyState>;
  if (!baseline.data) return <EmptyState title="Opening saved PCB"><Spinner /></EmptyState>;
  return <PlacementWorkspace key={placementSourceKey(client.baseUrl, baseline.data)} projectId={projectId} baseline={baseline.data} canvas={canvas} />;
}

function PlacementWorkspace({ projectId, baseline, canvas }: { projectId: string; baseline: PlacementSource; canvas: boolean }) {
  const panelId = useId();
  const queryClient = useQueryClient();
  const client = useCoreClient(),
    project = useProject(projectId);
  const scopeKey = placementSourceKey(client.baseUrl, baseline);
  const recoveryKey = "fabdesk-placement-source:" + scopeKey;
  const draftPath = placementSourceDraftPath(baseline);
  const cached = useRef(placementDrafts.get(scopeKey));
  const [toolbarHost, setToolbarHost] = useState<Element | null>(null);
  useLayoutEffect(() => { if (canvas) setToolbarHost(document.querySelector("[data-placement-toolbar-slot]")); }, [canvas]);
  const [history, setHistory] = useState<PlacementHistory | null>(cached.current?.history ?? null);
  const [savedRevision, setSavedRevision] = useState(cached.current?.savedRevision ?? -1);
  const [selection, setSelection] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<PlacementAnalysis>(EMPTY_ANALYSIS);
  const [checking, setChecking] = useState(false);
  const [preview, setPreview] = useState<{
    session: PlacementSession;
    review: PlacementReview;
    label: string;
    comparison?: PlacementResult["comparison"];
  } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [inspector, changeInspector] = useState<"parts" | "review" | "board">("parts");
  const [inspectorOpen, setInspectorOpen] = useState(!canvas);
  const inspectorContent = useRef<HTMLDivElement>(null);
  const setInspector = (tab: "parts" | "review" | "board") => { changeInspector(tab); setInspectorOpen(true); };
  useEffect(() => { inspectorContent.current?.scrollTo({ top: 0 }); }, [inspector, inspectorOpen]);
  const [side, setSide] = useState("both"),
    [net, setNet] = useState("selected");
  const [grid, setGrid] = useState(0.25),
    [push, setPush] = useState(true);
  const [mode, setMode] = useState<"select" | "pan" | "area">("select");
  const [allowRotation, setAllowRotation] = useState(true),
    [adjust, setAdjust] = useState(true),
    [swap, setSwap] = useState<string | null>(null);
  const [context, setContext] = useState<PlacementContext>({ neighbors: [], gap: null });
  const [library, setLibrary] = useState<{
    target: string | null;
    initial?: FootprintChoice;
    at?: Point;
  } | null>(null);
  const [enclosure, setEnclosure] = useState(false),
    [recovery, setRecovery] = useState("");
  const recoveryQueue = useRef(Promise.resolve()),
    recoveryVersion = useRef(0);
  const [zoom, setZoom] = useState({ factor: 1, nonce: 0 }),
    [zoomPercent, setZoomPercent] = useState(100);
  const issueCursor = useRef(-1);
  const [focus, setFocus] = useState({ ids: [] as string[], nonce: 0 });
  const [exported, setExported] = useState<PlacementCandidate | null>(cached.current?.candidate ?? null);
  const [copyOpen, setCopyOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [copyName, setCopyName] = useState("");
  const [exportOpen, setExportOpen] = useState(false),
    [replaceOpen, setReplaceOpen] = useState(false),
    [help, setHelp] = useState(false);
  const [gap, setGap] = useState(1),
    [axis, setAxis] = useState("x");
  const [width, setWidth] = useState(30),
    [height, setHeight] = useState(20);
  const [source, setSource] = useState(cached.current ? draftPath : baseline.path);
  const input = useRef<HTMLInputElement>(null),
    operation = useRef<AbortController | null>(null),
    initialized = useRef(!!cached.current);
  const replacement = useRef<(() => void) | null>(null),
    mounted = useRef(true);
  const session = preview?.session ?? history?.present;
  const dirty = !!history && history.revision !== savedRevision;
  const blocked = !!busy || !!preview;
  const files = canvas ? (project.data?.files.some(f => f.path === baseline.path) ? [baseline.path] : []) : placementBoardFiles(project.data?.files ?? []);
  const one =
    selection.length === 1 ? session?.parts.find((p) => p.id === selection[0]) : undefined;
  const selectedGroupIds = useMemo(
    () => new Set(session && selection.length ? expanded(session, selection) : []),
    [session, selection],
  );
  const groupLocked = !!session?.parts.some((p) => selectedGroupIds.has(p.id) && p.locked);
  const nets = useMemo(() => [...new Set(analysis.edges.map(edge => edge.name))].sort(), [analysis.edges]);
  const visibleEdges = analysis.edges.filter(edge => net === "off" ? false : net === "selected" ? selection.includes(edge.a.id) || selection.includes(edge.b.id) : !net || edge.name === net);
  const filtered =
    session?.parts.filter(
      (p) =>
        (side === "both" || p.side === side) &&
        `${p.ref} ${p.value} ${p.footprint}`.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  const focusParts = (ids: string[]) => {
    selectParts(ids);
    setFocus((f) => ({ ids, nonce: f.nonce + 1 }));
  };
  const commit = (next: PlacementSession) => {
    setHistory((h) => (h ? commitPlacement(h, next) : placementHistory(next)));
    setNotice(null);
    setError(null);
  };
  const change = (edit: (next: PlacementSession) => void) => {
    if (!history || blocked) return;
    try {
      const next = clone(history.present);
      edit(next);
      validatePlacementSettings(next);
      commit(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const selectParts = (ids: string[]) => {
    if (swap && ids.length === 1 && ids[0] !== swap) {
      change((next) => swapPlacement(next, swap, ids[0]!));
      setSwap(null);
    }
    setSelection(ids);
    if (ids.length) setInspector("parts");
  };
  const rotate = () => {
    if (selection.length) change((next) => rotateParts(next, selection));
  };
  const undo = () => {
    if (!blocked) setHistory((h) => (h ? undoPlacement(h) : null));
  };
  const redo = () => {
    if (!blocked) setHistory((h) => (h ? redoPlacement(h) : null));
  };

  useEffect(() => {
    if (!session) return;
    const entry = takePlacementEntry(projectId, baseline.sourceId);
    if (!entry) return;
    if (entry.sourceSha256 && entry.sourceSha256 !== baseline.sha256) {
      setNotice("The saved PCB changed after selecting that part. Select the footprint again in this draft.");
      return;
    }
    if (entry.tool === "resize") setInspector("board");
    else {
      const part = session.parts.find(part => part.ref === entry.ref);
      if (part) { setSelection([part.id]); setInspector("parts"); setLibrary({ target: part.id }); }
      else setNotice("That reference is not present in this draft. Choose a component to compare.");
    }
  }, [!!session, projectId, baseline.sourceId]);
  useEffect(() => {
    mounted.current = true;
    installDraftCloseGuard();
    return () => {
      mounted.current = false;
      initialized.current = false;
      operation.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (history) placementDrafts.set(scopeKey, history, savedRevision, exported ?? undefined);
  }, [scopeKey, history, savedRevision, exported]);
  useEffect(() => {
    if (!history) return;
    const version = ++recoveryVersion.current;
    if (!dirty) {
      try { localStorage.removeItem(recoveryKey); setRecovery("No unsaved changes"); } catch { setRecovery("Device recovery unavailable"); }
      return;
    }
    setRecovery("Saving recovery copy…");
    let queued = false;
    const flush = () => {
      if (queued) return;
      queued = true;
      const text = encodePlacementDraft(baseline, history.present);
      recoveryQueue.current = recoveryQueue.current
        .catch(() => {})
        .then(async () => {
          if (version !== recoveryVersion.current) return;
          try {
            await saveAutosave(localStorage, recoveryKey, text);
            if (mounted.current && version === recoveryVersion.current)
              setRecovery("Recovery copy saved on this device");
          } catch {
            if (mounted.current)
              setRecovery("Recovery unavailable — save or download your session");
          }
        });
    };
    const timer = setTimeout(flush, 350);
    return () => {
      clearTimeout(timer);
      flush();
    };
  }, [history, recoveryKey, dirty]);
  useEffect(() => {
    if (!session || !selection.length) {
      setContext({ neighbors: [], gap: null });
      return;
    }
    const c = new AbortController();
    setContext({ neighbors: [], gap: null });
    void placementJob({ kind: "context", session, ids: selection }, c.signal)
      .then((r) => { if (!c.signal.aborted) setContext(r.context!); })
      .catch(() => {});
    return () => c.abort();
  }, [session, selection]);
  useEffect(() => {
    if (session) {
      setWidth(session.board.w);
      setHeight(session.board.h);
    }
  }, [session?.board.w, session?.board.h]);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    setChecking(true);
    placementJob({ kind: "analyze", session }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setAnalysis(result.analysis!);
        setChecking(false);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(String(e));
          setChecking(false);
        }
      });
    return () => controller.abort();
  }, [session]);

  async function load(path: string, local?: File) {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setBusy("Opening board…");
    setError(null);
    try {
      const listed = project.data?.files.find((f) => f.path === path);
      if ((local?.size ?? listed?.size ?? 0) > MAX_PLACEMENT_BYTES)
        throw new Error("Choose a board or session smaller than 20 MB.");
      let text = local ? await local.text() : await client.readFile(projectId, path);
      if (canvas && (local || path !== baseline.path)) {
        // Source-bound mode must not save an unrelated imported layout as this board.
        if (!text.trimStart().startsWith("{")) {
          if (await sha256Blob(new Blob([text])) !== baseline.sha256) throw new Error("This is a different PCB. Open that board in its project before starting a placement draft.");
        } else text = decodePlacementDraft(text, baseline);
      } else if (text.trimStart().startsWith("{") && JSON.parse(text)?.contract === "fabplane.placement-draft.v1") text = JSON.stringify(JSON.parse(text).session);
      const result = await placementJob(
        { kind: "load", text, name: path.split(/[\\/]/).at(-1)! },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const nextHistory = history
        ? commitPlacement(history, result.session!)
        : placementHistory(result.session!);
      setHistory(nextHistory);
      setSavedRevision(path === draftPath && !local ? nextHistory.revision : -1);
      setSelection([]);
      setPreview(null);
      setAnalysis(EMPTY_ANALYSIS);
      setSource(path);
      setNet("off");
      setFocus((f) => ({ ids: [], nonce: f.nonce + 1 }));
      setNotice(
        path === draftPath
          ? "Saved placement draft restored."
          : "Working in a draft. Your source board is unchanged.",
      );
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!controller.signal.aborted && mounted.current) setBusy("");
    }
  }
  useEffect(() => {
    if (initialized.current || history || !project.data) return;
    initialized.current = true;
    const saved = project.data.files.some((f) => f.path === draftPath);
    const controller = new AbortController();
    operation.current = controller;
    setBusy("Restoring placement…");
    void restorePlacement({
      readRecovery: () => localStorage.getItem(recoveryKey),
      readFile: async (path) => {
        if (path !== baseline.path) return client.readFile(projectId, path);
        const bytes = await client.readFileBlob(projectId, path);
        if (await sha256Blob(bytes) !== baseline.sha256) throw new Error("The saved PCB changed while opening this draft. Reopen Placement to inspect the current source.");
        return bytes.text();
      },
      parse: async (text, name) =>
        (await placementJob({ kind: "load", text: name === baseline.path.split("/").at(-1) ? text : decodePlacementDraft(text, baseline), name }, controller.signal)).session!,
      paths: [...(saved ? [draftPath] : []), baseline.path],
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted || !mounted.current || !result) return;
        setHistory(placementHistory(result.session));
        setSavedRevision(result.source === DEVICE_PLACEMENT_RECOVERY ? -1 : 0);
        setSource(result.source);
        setError(null);
        setFocus((f) => ({ ids: [], nonce: f.nonce + 1 }));
        setNotice(
          result.skipped.length
            ? "Could not restore " +
                result.skipped.join(", ") +
                ". Opened " +
                result.source +
                " instead."
            : result.source === DEVICE_PLACEMENT_RECOVERY
              ? "Recovered your placement edits from this device."
              : result.source === draftPath
                ? "Saved placement draft restored."
                : null,
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted && mounted.current) setError(String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted && mounted.current) setBusy("");
      });
  }, [project.data]);

  const replace = (action: () => void) => {
    if (history) {
      replacement.current = action;
      setReplaceOpen(true);
    } else action();
  };
  async function save() {
    if (!history || blocked) return;
    setBusy("Saving layout…");
    setError(null);
    try {
      await client.writeFile(projectId, draftPath, encodePlacementDraft(baseline, history.present));
      placementDrafts.set(scopeKey, history, history.revision);
      if (mounted.current) {
        setSavedRevision(history.revision);
        setNotice(
          "Layout saved. The original PCB is unchanged; create a PCB copy when you are ready to route this layout.",
        );
        void project.refetch();
      }
    } catch (e) {
      if (mounted.current)
        setError(
          `Layout was not saved: ${e instanceof Error ? e.message : e}. Your edits are still here.`,
        );
    } finally {
      if (mounted.current) setBusy("");
    }
  }
  async function propose(job: PlacementJob, label: string) {
    if (blocked) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(`${label}…`);
    setError(null);
    try {
      const result = await placementJob(job, controller.signal);
      if (!controller.signal.aborted) {
        setPreview({
          session: result.session!,
          review: result.review!,
          label,
          ...(result.comparison ? { comparison: result.comparison } : {}),
        });
        setFocus((f) => ({ ids: [], nonce: f.nonce + 1 }));
        setInspector("review");
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!controller.signal.aborted && mounted.current) setBusy("");
    }
  }
  async function exportPcb() {
    if (!session || blocked) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy("Exporting copy…");
    setError(null);
    try {
      const result = await placementJob({ kind: "export", session }, controller.signal);
      if (controller.signal.aborted) return;
      const name = session.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "board";
      const path = `placement/${name}-${Date.now()}-unrouted.kicad_pcb`;
      await client.writeFile(projectId, path, result.text!);
      if (mounted.current) {
        setExportOpen(false);
        setExported({ path, sha256: await sha256Blob(new Blob([result.text!])), revision: history?.revision ?? 0, widthMm: session.board.w, heightMm: session.board.h });
        setInspector("review");
        if (canvas) { setCopyName(`${project.data?.name ?? session.name} — placement copy`.slice(0, 80)); setCopyOpen(true); }
        setNotice(
          `Exported ${path}. Tracks, vias and zones were removed; route and run DRC before manufacturing.`,
        );
        void project.refetch();
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(`Export failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      if (!controller.signal.aborted && mounted.current) setBusy("");
    }
  }

  async function continueCopy() {
    if (!exported || blocked || !copyName.trim()) return;
    setBusy("Preparing working copy…"); setError(null);
    try {
      const next = await createPlacementWorkingCopy(client, { source: baseline, candidate: exported, name: copyName,
        onProgress: (done, total) => { if (mounted.current) setBusy(`Copying source files ${done} of ${total}…`); },
      });
      const sources = await client.inspectBoardSources(next.id);
      const selected = baseline.sourceId ? captureAssemblySourceSelection(sources, baseline.sourceId) : null;
      if (baseline.sourceId && !selected) throw new Error("Working copy created, but its member source could not be verified. Open the new project from Home to inspect it.");
      if (!mounted.current || useUiStore.getState().activeProjectId !== projectId) return;
      const ui = useUiStore.getState();
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      if (!ui.closeProject() || !ui.setActiveProject(next.id)) throw new Error("Working copy is ready. Close the current project and open it from Home to continue.");
      if (selected) ui.setAssemblyBoard(selected);
      ui.setBoardTab("cinema");
    } catch (error) { if (mounted.current) { setError(error instanceof Error ? error.message : String(error)); setCopyOpen(false); } }
    finally { if (mounted.current) setBusy(""); }
  }
  const downloadSession = () => {
    if (!history) return;
    const url = URL.createObjectURL(
        new Blob([encodePlacementDraft(baseline, history.present)], { type: "application/json" }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = history.present.name + ".placement.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  const loadExample = async (name: string) => {
    const examples = await loadPlacementExamples();
    const example = examples.find((x) => x.name === name);
    if (example)
      replace(() => void load(name + ".kicad_pcb", new File([example.text], name + ".kicad_pcb")));
  };
  const surface = { projectId, label: "PCB / Placement draft", priority: 25, details: JSON.stringify({
    source: baseline, openedFrom: source, draftPath, savedPCB: "unchanged by this editor", unsaved: dirty,
    preview: preview?.label ?? null, dimensionsMm: session?.board,
    selected: session?.parts.filter(p => selection.includes(p.id)).map(p => ({ ref: p.ref, value: p.value, footprint: p.footprint, x: p.x, y: p.y, angle: p.angle })),
    placementFindings: analysis.findings.length, coverage: "Geometry only; electrical, routing and manufacturing checks are separate",
  }) };
  useAssistantSurface(session ? surface : null);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      const ui = useUiStore.getState();
      if (ui.activeProjectId !== projectId || ui.boardTab !== "placement" || event.defaultPrevented || library || help || exportOpen || copyOpen || replaceOpen || enclosure || leaveOpen) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input,textarea,select,[contenteditable="true"],[role="combobox"],[role="listbox"]')) return;
      const key = event.key.toLowerCase(), mod = event.metaKey || event.ctrlKey;
      if (mod && !event.altKey && (key === "z" || key === "y")) {
        event.preventDefault(); event.stopPropagation();
        if (!blocked) key === "y" || event.shiftKey ? redo() : undo();
      } else if (!mod && !event.altKey && (key === "v" || key === "h")) {
        event.preventDefault(); event.stopPropagation(); setMode(key === "v" ? "select" : "pan");
        document.querySelector<HTMLCanvasElement>(".fd-placement-canvas")?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [projectId, blocked, library, help, exportOpen, copyOpen, replaceOpen, enclosure, leaveOpen]);
  const exitPlacement = () => { if (preview) setLeaveOpen(true); else useUiStore.getState().setBoardTab("pcb"); };
  const taskTools = <div className="fd-placement-mode-tools">
    <Button size="sm" variant="secondary" disabled={!!busy} onClick={exitPlacement}><Icon name="chevronLeft" width={16} height={16} />Back to PCB</Button>
    <Button size="sm" variant="secondary" aria-pressed={inspectorOpen && inspector === "parts"} onClick={() => setInspector("parts")}>Arrange</Button>
    <Button size="sm" variant="secondary" aria-pressed={inspectorOpen && inspector === "board"} onClick={() => setInspector("board")}>Resize</Button>
    <Button size="sm" variant="secondary" aria-pressed={inspectorOpen && inspector === "review"} onClick={() => setInspector("review")}>Layout checks</Button>
    <CanvasToolButton icon="sparkles" label="Ask about this placement draft" onClick={() => { setInspectorOpen(false); askAboutSurface(surface, selection.length ? "Review the selected footprints in my placement draft. Explain placement concerns and suggest the next step before making changes." : "Review this placement draft and suggest the next step. Explain geometry concerns separately from electrical checks. The saved PCB is unchanged."); }} />
  </div>;
  return (
    <section
      className={`fd-placement${canvas ? " fd-placement-canvas-workspace" : ""}${inspectorOpen ? " has-inspector" : ""}`}
      data-testid="placement-workspace"
      aria-label="Placement workspace"
    >
      {canvas && (toolbarHost ? createPortal(taskTools, toolbarHost) : taskTools)}
      <header className="fd-placement-header">
        <div className="fd-placement-title">
          <span className="fd-placement-symbol">
            <Icon name="pcb" width={21} height={21} />
          </span>
          <div>
            <h2>Placement</h2>
            <p>{session ? session.name : "Give every component its place"}</p>
          </div>
        </div>
        {canvas && session && <div className="fd-placement-source-chip"><Icon name="pcb" width={14} height={14} /><span><strong>Editing placement</strong>{dirty ? " · Unsaved changes" : " · Layout saved"} · {fmt(session.board.w)} × {fmt(session.board.h)} mm · {session.parts.length} parts</span><small>Edits stay separate from the original PCB</small></div>}
        <div className="fd-placement-actions">
          {session && (
            <span className={`fd-placement-save-state ${dirty ? "is-dirty" : ""}`}>
              {dirty ? "Unsaved draft" : "No unsaved changes"}
            </span>
          )}
          <WorkspaceMenu label={<><Icon name="moreVertical" width={18} height={18} /><span className="sr-only">More placement options</span></>}>
            <div className="fd-menu-caption">Layout files</div>
            <button disabled={blocked} onClick={() => input.current?.click()}>{canvas ? "Open saved layout…" : "Open board or draft…"}</button>
            <button disabled={!session || blocked} onClick={downloadSession}>Download layout file</button>
            <button disabled={!session || blocked} onClick={() => setLibrary({ target: null })}>Add unconnected footprint…</button>
            {!canvas && <button disabled={!session || blocked} onClick={() => setEnclosure(true)}>Enclosure / STL…</button>}
            <button onClick={() => setHelp(true)}>Placement help</button>
          </WorkspaceMenu>
          {session && (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={blocked}
                onClick={() => setExportOpen(true)}
              >
                <Icon name="export" width={14} height={14} /> Create PCB copy…
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={blocked || !dirty}
                onClick={() => void save()}
              >
                Save layout
              </Button>
            </>
          )}
        </div>
        <input
          ref={input}
          type="file"
          accept=".kicad_pcb,.json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) replace(() => void load(file.name, file));
            e.target.value = "";
          }}
        />
      </header>
      {error && (
        <div className="fd-placement-message is-error" role="alert">
          <Icon name="warning" width={16} height={16} />
          <span>{error}</span>
          <button aria-label="Dismiss placement error" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}
      {notice && (
        <div className="fd-placement-message" role="status">
          <Icon name="check" width={15} height={15} />
          <span>{notice}</span>
          <button aria-label="Dismiss placement notice" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}
      {!session ? (
        <div
          className="fd-placement-empty"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file && !busy) void load(file.name, file);
          }}
        >
          <div className="fd-placement-illustration">
            <Icon name="pcb" width={66} height={66} />
          </div>
          <span className="fd-placement-eyebrow">BOARD PLACEMENT</span>
          <h3>A little room. A better layout.</h3>
          <p>
            Arrange components, inspect their connections, and explore a cleaner layout. Start with
            your project board or open a KiCad file.
          </p>
          {busy || project.isLoading ? (
            <div className="fd-placement-loading">
              <Spinner /> {busy || "Finding project boards…"}
            </div>
          ) : (
            <div className="fd-placement-empty-actions">
              {files.length > 0 && (
                <Button onClick={() => void load(files[0]!)}>Open project board</Button>
              )}
              <Button variant="secondary" onClick={() => input.current?.click()}>
                Open KiCad board
              </Button>
              {project.isError && (
                <Button variant="secondary" onClick={() => void project.refetch()}>
                  Retry project
                </Button>
              )}
            </div>
          )}
          <div className="fd-placement-empty-actions">
            <Button disabled={!!busy} onClick={() => void loadExample("usb-timer")}>
              Try USB timer
            </Button>
            <Button disabled={!!busy} onClick={() => void loadExample("constraint-board")}>
              Try connectors &amp; cutout
            </Button>
          </div>
          <small>Drop a .kicad_pcb or .placement.json here. Source files stay unchanged.</small>
          <div className="fd-placement-steps">
            <span>
              <b>01</b> Arrange parts
            </span>
            <span>
              <b>02</b> Review changes
            </span>
            <span>
              <b>03</b> Export a copy
            </span>
          </div>
        </div>
      ) : (
        <>
          <div className="fd-placement-overview">
            <div>
              <strong>
                {fmt(session.board.w)} × {fmt(session.board.h)} mm
              </strong>
              <button onClick={() => setInspector("board")}>Resize board…</button>
              <span>
                {session.parts.length} components ·{" "}
                {session.resized ? "Resized outline" : "Original outline"}
              </span>
            </div>
            <span title={recovery}>{recovery}</span>
            <button
              disabled={!analysis.findings.length}
              onClick={() => {
                issueCursor.current = (issueCursor.current + 1) % analysis.findings.length;
                focusParts(analysis.findings[issueCursor.current]!.ids);
                setInspector("review");
              }}
            >
              Review next finding →
            </button>
          </div>
          {swap && (
            <div className="fd-placement-preview">
              Choose another unlocked individual component to swap positions.{" "}
              <button onClick={() => setSwap(null)}>Cancel swap</button>
            </div>
          )}
          <div className="fd-placement-toolbox">
            <div className="fd-placement-edit-tools" role="toolbar" aria-label="Placement editing tools">
              <Button size="sm" variant={mode === "select" ? "secondary" : "ghost"} aria-pressed={mode === "select"} title="Select and move components (V)" onClick={() => setMode("select")}><Icon name="cursor" width={17} height={17} />Select</Button>
              <Button size="sm" variant={mode === "pan" ? "secondary" : "ghost"} aria-pressed={mode === "pan"} title="Pan canvas (H). Hold Space and drag for temporary pan." onClick={() => setMode("pan")}><Icon name="hand" width={17} height={17} />Pan</Button>
              <span className="fd-placement-divider" />
              <Button size="sm" variant="ghost" disabled={blocked || !history?.past.length} title="Undo (⌘Z / Ctrl+Z)" aria-label="Undo placement change" onClick={undo}><Icon name="undo" width={17} height={17} /></Button>
              <Button size="sm" variant="ghost" disabled={blocked || !history?.future.length} title="Redo (⌘⇧Z / Ctrl+Shift+Z / Ctrl+Y)" aria-label="Redo placement change" onClick={redo}><Icon name="redo" width={17} height={17} /></Button>
              <span className="fd-placement-divider" />
              <WorkspaceMenu label={<><Icon name="settings" width={17} height={17} /><span className="sr-only">Placement settings</span></>}>
          <div className="fd-placement-toolbar" aria-label="Placement settings">
            <div className="fd-menu-caption">Movement</div>
            <label>
              Snap{" "}
              <Select
                aria-label="Placement snap grid"
                value={grid}
                onChange={(e) => setGrid(Number(e.target.value))}
              >
                <option value={0}>Off</option>
                {[0.1, 0.25, 0.5, 1].map((n) => (
                  <option key={n} value={n}>
                    {n} mm
                  </option>
                ))}
              </Select>
            </label>
            <label className="fd-placement-check">
              <input
                type="checkbox"
                checked={push && session.parts.length <= 200}
                disabled={session.parts.length > 200}
                onChange={(e) => setPush(e.target.checked)}
              />
              Push neighbors
            </label>
            <button disabled={!selection.length} onClick={() => setFocus(f => ({ ids: selection, nonce: f.nonce + 1 }))}>Focus selected parts (F)</button>
            <button disabled={blocked} aria-pressed={mode === "area"} onClick={() => { setMode(mode === "area" ? "select" : "area"); setInspector("board"); }}>Reserve board space…</button>
            <p>Reserved space is a placement guide, not an enclosure.</p>
          </div>
          </WorkspaceMenu></div></div>
          {preview && (
            <div className="fd-placement-preview" role="status">
              <div>
                <strong>Preview — not applied · {preview.label}</strong>
                {canvas && <small>{preview.review.changed.length} {preview.review.changed.length === 1 ? "part" : "parts"} changed · review the canvas before applying</small>}
                {preview.comparison && (
                  <p>
                    Estimated connections {fmt(preview.comparison.before)} →{" "}
                    {fmt(preview.comparison.after)} mm · Weighted score{" "}
                    {fmt(preview.comparison.beforeScore)} → {fmt(preview.comparison.afterScore)}
                    {preview.comparison.timedOut ? " · Search time limit reached" : ""}
                  </p>
                )}
                <p>
                  {preview.review.changed.length}{" "}
                  {preview.review.changed.length === 1 ? "part" : "parts"} changed ·{" "}
                  {preview.review.resolved.length} findings resolved · {preview.review.added.length}{" "}
                  new findings · dashed outlines show the original
                </p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => setPreview(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  commit(preview.session);
                  setPreview(null);
                }}
              >
                Use this layout
              </Button>
            </div>
          )}
          <div className="fd-placement-body">
            <div className="fd-placement-stage">
              <div className="fd-placement-view-controls">
                <Select
                  aria-label="Board side"
                  value={side}
                  onChange={(e) => {
                    setSide(e.target.value);
                    setSelection([]);
                  }}
                >
                  <option value="both">Both sides</option>
                  <option value="F">Front</option>
                  <option value="B">Back</option>
                </Select>
                <Select
                  aria-label="Show net connections"
                  value={net}
                  onChange={(e) => setNet(e.target.value)}
                >
                  <option value="selected">Selected part</option>
                  <option value="off">Hide connections</option>
                  <option value="">All connections</option>
                  {nets.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </Select>
                <span>
                  {fmt(session.board.w)} × {fmt(session.board.h)} mm
                </span>
              </div>
              {canvas && <p className="fd-placement-interaction-hint">{mode === "pan" ? "Pan: drag anywhere to move the view. Select (V) to move components." : mode === "area" ? "Drag to reserve space. Escape cancels." : "Select: click or drag a component · Shift-click selects more · Space + drag pans"}</p>}
              {canvas && net !== "off" && <div className="fd-placement-connection-legend"><span className="fd-placement-airwire-sample" /><span>{net === "selected" && !selection.length ? "Select a component to see its connections" : `${net && net !== "selected" ? net + " · " : ""}${visibleEdges.length} airwire${visibleEdges.length === 1 ? "" : "s"}`}</span><small>Connection guides, not routed copper</small></div>}
              <PlacementCanvas
                session={session}
                baseline={preview ? history?.present : undefined}
                selection={selection}
                edges={analysis.edges}
                net={net}
                side={side}
                push={push}
                grid={grid}
                mode={mode}
                disabled={blocked}
                focus={focus}
                onSelection={selectParts}
                onResize={(w, h) =>
                  void propose(
                    { kind: "resize", session, w, h, adjust },
                    `Resize to ${fmt(w)} × ${fmt(h)} mm`,
                  )
                }
                onArea={(x, y, w, h) => {
                  change((next) => {
                    next.reservedAreas ??= [];
                    next.reservedAreas.push({
                      id: crypto.randomUUID(),
                      name: `Reserved ${next.reservedAreas.length + 1}`,
                      x,
                      y,
                      w,
                      h,
                      margin: 0.25,
                      side: "both",
                    });
                  });
                  setMode("select");
                  setInspector("board");
                }}
                onEscape={() => {
                  setMode("select");
                  setSwap(null);
                  setPreview(null);
                }}
                onFile={(file) => replace(() => void load(file.name, file))}
                onFootprint={(choice, target, at) => setLibrary({ target, initial: choice, at })}
                zoom={zoom}
                onZoom={setZoomPercent}
                gap={context.gap}
                findings={analysis.findings}
                swapActive={!!swap}
                onCommit={commit}
                onRotate={rotate}
                onUndo={undo}
                onRedo={redo}
                onError={setError}
              />
              <div className="fd-placement-zoom">
                <button
                  aria-label="Zoom out"
                  onClick={() => setZoom((z) => ({ factor: 0.8, nonce: z.nonce + 1 }))}
                >
                  −
                </button>
                <span>{zoomPercent}%</span>
                <button
                  aria-label="Zoom in"
                  onClick={() => setZoom((z) => ({ factor: 1.25, nonce: z.nonce + 1 }))}
                >
                  +
                </button>
              </div>
              {canvas && <div className="fd-placement-fit"><Button size="sm" onClick={() => setFocus(f => ({ ids: [], nonce: f.nonce + 1 }))}>Fit board</Button></div>}
              {context.gap && (
                <div className="fd-placement-gap">
                  {context.gap.overlap ? "Envelope overlap" : fmt(context.gap.distance) + " mm gap"}{" "}
                  · {context.gap.ref}
                </div>
              )}
              <div className="fd-placement-canvas-hint">
                Scroll to zoom <span>·</span> Space + drag to pan <span>·</span> Shift-click to
                select more
              </div>
              {busy && (
                <div className="fd-placement-busy" role="status">
                  <Spinner />
                  <span>{busy}</span>
                </div>
              )}
            </div>
            <aside className="fd-placement-inspector" aria-label="Placement inspector" hidden={!inspectorOpen}>
              <div className="fd-placement-inspector-heading"><strong>{inspector === "board" ? "Board dimensions" : inspector === "review" ? "Layout checks" : "Arrange parts"}</strong><CanvasToolButton icon="close" label="Collapse placement inspector" onClick={() => setInspectorOpen(false)} /></div>
              <div
                className="fd-placement-inspector-tabs"
                role="tablist"
                aria-label="Placement details"
                onKeyDown={(event) => {
                  const tabs = ["parts", "review", "board"] as const;
                  const i = tabs.indexOf(inspector);
                  const next =
                    event.key === "ArrowRight"
                      ? (i + 1) % 3
                      : event.key === "ArrowLeft"
                        ? (i + 2) % 3
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? 2
                            : -1;
                  if (next < 0) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setInspector(tabs[next]!);
                  event.currentTarget
                    .querySelectorAll<HTMLButtonElement>('[role="tab"]')
                    [next]?.focus();
                }}
              >
                {(["parts", "review", "board"] as const).map((tab) => (
                  <button
                    role="tab"
                    key={tab}
                    id={`${panelId}-${tab}`}
                    aria-controls={panelId}
                    tabIndex={inspector === tab ? 0 : -1}
                    aria-selected={inspector === tab}
                    onClick={() => setInspector(tab)}
                  >
                    {tab === "parts"
                      ? "Parts"
                      : tab === "review"
                        ? `Checks${!checking && analysis.findings.length ? ` (${analysis.findings.length})` : ""}`
                        : "Board"}
                  </button>
                ))}
              </div>
              <div
                className="fd-placement-inspector-content"
                ref={inspectorContent}
                role="tabpanel"
                id={panelId}
                aria-labelledby={`${panelId}-${inspector}`}
              >
                {inspector === "parts" && (
                  <>
                    <div className="fd-placement-section">
                      <div className="fd-placement-section-title">
                        <h3>
                          {one
                            ? one.ref
                            : selection.length
                              ? `${selection.length} parts selected`
                              : "Select a component"}
                        </h3>
                        {selection.length > 0 && (
                          <button onClick={() => setSelection([])}>Clear</button>
                        )}
                      </div>
                      {one ? (
                        <>
                          <div className="fd-placement-part-picture">
                            <FootprintPicture part={one} />
                          </div>
                          <label className="fd-placement-field">
                            <span>Value</span>
                            <input
                              key={one.id + one.value}
                              aria-label="Part value"
                              defaultValue={one.value}
                              disabled={blocked}
                              onBlur={(e) => {
                                if (e.target.value !== one.value)
                                  change((next) =>
                                    setPartValue(
                                      next.parts.find((p) => p.id === one.id)!,
                                      e.target.value,
                                    ),
                                  );
                              }}
                            />
                          </label>
                          <small className="fd-placement-footprint">
                            {one.footprint} · {one.side === "F" ? "Front" : "Back"} ·{" "}
                            {fmt(one.angle)}°
                          </small>
                          <div className="fd-placement-field-pair">
                            <NumberField
                              label="X · mm"
                              value={one.x}
                              disabled={
                                blocked ||
                                groupLocked ||
                                session.parts.some(
                                  (p) =>
                                    selectedGroupIds.has(p.id) &&
                                    ["left", "right"].includes(p.anchor?.edge ?? ""),
                                )
                              }
                              onChange={(x) =>
                                change((next) => moveParts(next, selection, x - one.x, 0))
                              }
                            />
                            <NumberField
                              label="Y · mm"
                              value={one.y}
                              disabled={
                                blocked ||
                                groupLocked ||
                                session.parts.some(
                                  (p) =>
                                    selectedGroupIds.has(p.id) &&
                                    ["top", "bottom"].includes(p.anchor?.edge ?? ""),
                                )
                              }
                              onChange={(y) =>
                                change((next) => moveParts(next, selection, 0, y - one.y))
                              }
                            />
                          </div>
                          <NumberField
                            label="Rotation · degrees"
                            value={one.angle}
                            step={90}
                            disabled={blocked || groupLocked || !!one.anchor}
                            onChange={(angle) =>
                              change((next) => rotateParts(next, [one.id], angle - one.angle))
                            }
                          />
                          <button
                            className="fd-placement-wide"
                            disabled={blocked || groupLocked || !!one.anchor || !!one.group}
                            onClick={() => setSwap(one.id)}
                          >
                            Swap position…
                          </button>
                          <label className="fd-placement-field">
                            <span>Edge anchor</span>
                            <Select
                              disabled={blocked || groupLocked}
                              value={one.anchor?.edge ?? ""}
                              onChange={(e) =>
                                change((next) =>
                                  setAnchor(
                                    next,
                                    next.parts.find((p) => p.id === one.id)!,
                                    e.target.value,
                                  ),
                                )
                              }
                            >
                              <option value="">Free to move</option>
                              {["left", "right", "top", "bottom"].map((edge) => (
                                <option key={edge}>{edge}</option>
                              ))}
                            </Select>
                          </label>
                        </>
                      ) : (
                        <p>
                          {selection.length
                            ? "Edit these components together. Locked members keep their group fixed."
                            : "Click a footprint on the board or find one below. Drag to move; use the arrow keys for precise nudges."}
                        </p>
                      )}
                      {!!selection.length && (
                        <div className="fd-placement-button-grid">
                          <button disabled={blocked || groupLocked} onClick={rotate}>
                            Rotate 90°
                          </button>
                          <button
                            disabled={blocked}
                            onClick={() =>
                              change((next) => {
                                for (const p of next.parts)
                                  if (selectedGroupIds.has(p.id)) p.locked = !groupLocked;
                              })
                            }
                          >
                            {groupLocked ? "Unlock" : "Lock position"}
                          </button>
                          <button
                            disabled={blocked || selection.length < 2}
                            onClick={() =>
                              change((next) => {
                                groupParts(next, selection);
                              })
                            }
                          >
                            Group
                          </button>
                          <button
                            disabled={
                              blocked ||
                              !session.parts.some((p) => selection.includes(p.id) && p.group)
                            }
                            onClick={() => change((next) => ungroupParts(next, selection))}
                          >
                            Ungroup
                          </button>
                        </div>
                      )}
                      {one && (
                        <>
                          <button
                            className="fd-placement-wide"
                            disabled={blocked || groupLocked}
                            onClick={() => setLibrary({ target: one.id })}
                          >
                            Compare replacement footprint…
                          </button>
                          <p className="fd-placement-small-note">
                            Compare library or local footprints, dimensions, pin 1 and pad-to-net
                            mappings.
                          </p>
                          {one.anchor && (
                            <NumberField
                              label="Anchor origin offset · mm"
                              value={one.anchor.offset}
                              min={-2000}
                              max={2000}
                              disabled={blocked || groupLocked}
                              onChange={(n) => change((next) => setAnchorOffset(next, one.id, n))}
                            />
                          )}
                          <p className="fd-placement-small-note">
                            Geometry: {one.geometrySource}. Orange dot marks pin 1.
                          </p>
                          {one.anchor && (
                            <label className="fd-placement-check">
                              <input
                                type="checkbox"
                                checked={one.overhang ?? false}
                                disabled={blocked}
                                onChange={(e) =>
                                  change((next) => {
                                    next.parts.find((p) => p.id === one.id)!.overhang =
                                      e.target.checked;
                                  })
                                }
                              />
                              Allow overhang at this edge
                            </label>
                          )}
                        </>
                      )}
                      {selection.length >= 2 && (
                        <details>
                          <summary>Align & space</summary>
                          <div className="fd-placement-button-grid">
                            {[
                              ["align-y", "Align row"],
                              ["align-x", "Align column"],
                              ["distribute-x", "Distribute X"],
                              ["distribute-y", "Distribute Y"],
                            ].map(([value, label]) => (
                              <button
                                key={value}
                                disabled={blocked || groupLocked}
                                onClick={() =>
                                  change((next) => alignParts(next, selection, value!))
                                }
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                          <div className="fd-placement-field-pair">
                            <label className="fd-placement-field">
                              <span>Direction</span>
                              <Select value={axis} onChange={(e) => setAxis(e.target.value)}>
                                <option value="x">Horizontal</option>
                                <option value="y">Vertical</option>
                              </Select>
                            </label>
                            <NumberField
                              label="Gap · mm"
                              value={gap}
                              min={0}
                              max={100}
                              onChange={setGap}
                            />
                          </div>
                          <button
                            className="fd-placement-wide"
                            disabled={blocked || groupLocked}
                            onClick={() =>
                              void propose(
                                { kind: "space", session, ids: selection, axis, gap },
                                "Exact spacing",
                              )
                            }
                          >
                            Preview spacing
                          </button>
                        </details>
                      )}
                    </div>
                    <div className="fd-placement-section">
                      {selection.length > 0 && (
                        <div className="fd-placement-context">
                          <h3>Placement context</h3>
                          {context.gap && (
                            <p>
                              {context.gap.overlap
                                ? "Envelope overlap with"
                                : fmt(context.gap.distance) + " mm envelope gap to"}{" "}
                              <strong>{context.gap.ref}</strong>
                            </p>
                          )}
                          <details open>
                            <summary>Connected neighbors ({context.neighbors.length})</summary>
                            <p>
                              Nearest pad distance. Select a neighbor to highlight the shared net.
                            </p>
                            {context.neighbors.map((n) => (
                              <button
                                className="fd-placement-neighbor"
                                key={n.id + ":" + n.net}
                                onClick={() => {
                                  setNet(n.net);
                                  setFocus((f) => ({
                                    ids: [...selection, n.id],
                                    nonce: f.nonce + 1,
                                  }));
                                }}
                              >
                                <strong>{n.ref}</strong>
                                <span>{n.net}</span>
                                <small>{fmt(n.distance)} mm</small>
                              </button>
                            ))}
                          </details>
                        </div>
                      )}
                      <label className="fd-placement-search">
                        <Icon name="search" width={15} height={15} />
                        <input
                          aria-label="Search placement parts"
                          placeholder="Find a reference or value…"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                        />
                      </label>
                      <div className="fd-placement-list-caption">
                        {filtered.length} components <span>Shift-click to select several</span>
                      </div>
                      <div className="fd-placement-parts" aria-label="Components">
                        {filtered.map((p) => (
                          <button
                            key={p.id}
                            className={selection.includes(p.id) ? "is-selected" : ""}
                            aria-pressed={selection.includes(p.id)}
                            onClick={(e) => {
                              const ids = expanded(session, [p.id]);
                              selectParts(
                                e.shiftKey
                                  ? selection.includes(p.id)
                                    ? selection.filter((id) => !ids.includes(id))
                                    : expanded(session, [...selection, p.id])
                                  : ids,
                              );
                            }}
                          >
                            <strong>{p.ref}</strong>
                            <span>{p.value || p.footprint}</span>
                            <small>{p.locked ? "Locked" : p.group ? "Group" : p.side}</small>
                          </button>
                        ))}
                        {!filtered.length && <p>No components match this search.</p>}
                      </div>
                    </div>
                  </>
                )}
                {inspector === "review" && (
                  <>
                    <div className="fd-placement-section">
                      <div
                        className={`fd-placement-health ${analysis.findings.length ? "has-findings" : ""}`}
                      >
                        <Icon
                          name={analysis.findings.length ? "warning" : "check"}
                          width={20}
                          height={20}
                        />
                        <div>
                          <strong>
                            {checking
                              ? "Checking placement…"
                              : `${analysis.findings.length} placement finding${analysis.findings.length === 1 ? "" : "s"}`}
                          </strong>
                          <p>Geometry checks, separate from KiCad DRC.</p>
                        </div>
                      </div>
                      <div className="fd-placement-metric">
                        <span>Estimated connections</span>
                        <strong>{checking ? "…" : `${fmt(analysis.length)} mm`}</strong>
                      </div>
                      <p>Explore shorter connections while preserving locks, groups and anchors.</p>
                      <label className="fd-placement-check">
                        <input
                          type="checkbox"
                          checked={allowRotation}
                          disabled={blocked}
                          onChange={(e) => setAllowRotation(e.target.checked)}
                        />
                        Allow rotation in suggestions
                      </label>
                      <button
                        className="fd-placement-primary-action"
                        disabled={blocked || checking}
                        onClick={() =>
                          void propose(
                            { kind: "improve", session, ids: selection, allowRotation },
                            selection.length ? "Improve selection" : "Improve placement",
                          )
                        }
                      >
                        Preview better placement <span>→</span>
                      </button>
                      <button
                        className="fd-placement-wide"
                        disabled={blocked || checking}
                        onClick={() => void propose({ kind: "relax", session }, "Resolve overlaps")}
                      >
                        Preview overlap cleanup
                      </button>
                    </div>
                    <div className="fd-placement-section">
                      <details>
                        <summary>Connection priorities</summary>
                        <p>
                          Choose a net above, then give it more weight in placement suggestions.
                          This does not change electrical rules.
                        </p>
                        <div className="fd-placement-button-grid">
                          <button
                            disabled={blocked || !net || net === "off"}
                            onClick={() =>
                              change((next) => {
                                next.netWeights = Object.fromEntries(
                                  nets.map((n) => [n, n === net ? 1 : 0]),
                                );
                              })
                            }
                          >
                            Use highlighted net only
                          </button>
                          <button
                            disabled={blocked}
                            onClick={() =>
                              change((next) => {
                                next.netWeights = {};
                              })
                            }
                          >
                            Reset weights
                          </button>
                        </div>
                        {nets.map((n) => (
                          <NumberField
                            key={n}
                            label={n}
                            value={session.netWeights?.[n] ?? 1}
                            min={0}
                            max={100}
                            step={1}
                            disabled={blocked}
                            onChange={(weight) =>
                              change((next) => {
                                next.netWeights = { ...next.netWeights, [n]: weight };
                              })
                            }
                          />
                        ))}
                      </details>
                    </div>
                    {exported && <div className="fd-placement-section fd-placement-exported"><h3>PCB copy ready</h3><p>This copy has no tracks, vias or zones. It is separate from the saved PCB used by Routing and Checks.</p><p className="fd-placement-footprint">{exported.path}</p><Button size="sm" variant="primary" disabled={blocked} onClick={() => { setCopyName(`${project.data?.name ?? session.name} — placement copy`.slice(0, 80)); setCopyOpen(true); }}>Continue in a working copy</Button><Button size="sm" onClick={() => useUiStore.getState().openProjectFile(exported.path)}>Inspect exported copy</Button><Button size="sm" variant="secondary" onClick={() => askAboutSurface({ ...surface, label: "Placement / Exported unrouted copy", details: JSON.stringify({ ...JSON.parse(surface.details), exportedCopy: exported }) }, "Help me continue from this exported placement copy. Explain how to work on this copy separately, route it and run checks without replacing the original PCB.")}>Ask how to continue</Button></div>}
                    <div className="fd-placement-section">
                      <h3>Findings to review</h3>
                      {checking ? (
                        <p>Updating checks…</p>
                      ) : analysis.findings.length ? (
                        analysis.findings.map((finding, i) => (
                          <button
                            className="fd-placement-finding"
                            key={i}
                            onClick={() => focusParts(finding.ids)}
                          >
                            <span>{finding.kind}</span>
                            {finding.text}
                          </button>
                        ))
                      ) : (
                        <p>
                          No placement findings. Run KiCad DRC after routing to check the electrical
                          design.
                        </p>
                      )}

                      {analysis.guidelines.length > 0 && (
                        <details>
                          <summary>{analysis.guidelines.length} advisory spacing targets</summary>
                          {analysis.guidelines.map((g, i) => (
                            <button
                              key={i}
                              className="fd-placement-finding is-advisory"
                              onClick={() => focusParts(g.ids)}
                            >
                              {g.text}
                            </button>
                          ))}
                        </details>
                      )}
                    </div>
                    {preview && (
                      <div className="fd-placement-section">
                        <h3>Changed parts</h3>
                        {preview.review.changed.map((p) => (
                          <button
                            className="fd-placement-change"
                            key={p.id}
                            onClick={() => focusParts([p.id])}
                          >
                            <strong>{p.ref}</strong>
                            <span>
                              {(() => {
                                const before = history?.present.parts.find(part => part.id === p.id);
                                const after = preview.session.parts.find(part => part.id === p.id);
                                if (before && after && before.footprint !== after.footprint) return `Footprint: ${before.footprint} → ${after.footprint}`;
                                if (before && after && before.value !== after.value) return `Value: ${before.value} → ${after.value}`;
                                return `${p.from?.map(fmt).join(", ") ?? "New"} → ${p.to.map(fmt).join(", ")}`;
                              })()}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
                {inspector === "board" && (
                  <>
                    <div className="fd-placement-section">
                      <h3>Board dimensions</h3>
                      <label className="fd-placement-check">
                        <input
                          type="checkbox"
                          checked={adjust}
                          disabled={blocked}
                          onChange={(e) => setAdjust(e.target.checked)}
                        />
                        Adjust placement when resizing
                      </label>
                      <p>Drag the board's bottom-right handle, or enter exact dimensions below.</p>
                      <p>
                        Preview a new outline size. Footprints and cutouts keep their physical
                        dimensions.
                      </p>
                      <div className="fd-placement-field-pair">
                        <NumberField
                          label="Width · mm"
                          value={width}
                          min={5}
                          max={2000}
                          onChange={setWidth}
                        />
                        <NumberField
                          label="Height · mm"
                          value={height}
                          min={5}
                          max={2000}
                          onChange={setHeight}
                        />
                      </div>
                      <button
                        className="fd-placement-wide"
                        disabled={blocked}
                        onClick={() =>
                          void propose(
                            { kind: "resize", session, w: width, h: height, adjust },
                            "Resize board",
                          )
                        }
                      >
                        Preview resize
                      </button>
                    </div>
                    <details className="fd-placement-section">
                      <summary>Open another source or example</summary>
                      {!canvas && <label className="fd-placement-field">
                        <span>Try an example</span>
                        <Select
                          aria-label="Example board"
                          value=""
                          disabled={blocked}
                          onChange={(e) => void loadExample(e.target.value)}
                        >
                          <option value="">Choose an example…</option>
                          <option value="usb-timer">USB timer</option>
                          <option value="constraint-board">Connectors &amp; cutout</option>
                        </Select>
                      </label>}
                      <p>
                        Open a board from this project. Existing placement edits stay in your draft
                        until you replace it.
                      </p>
                      <Select
                        aria-label="Project board file"
                        value={files.includes(source) ? source : ""}
                        disabled={blocked}
                        onChange={(e) => {
                          if (e.target.value) {
                            const path = e.target.value;
                            replace(() => void load(path));
                          }
                        }}
                      >
                        <option value="">Choose a project board…</option>
                        {files.map((path) => (
                          <option key={path}>{path}</option>
                        ))}
                      </Select>
                      {project.data?.files.some((f) => f.path === draftPath) && (
                        <button
                          className="fd-placement-wide"
                          disabled={blocked}
                          onClick={() => replace(() => void load(draftPath))}
                        >
                          Reopen saved draft
                        </button>
                      )}
                    </details>
                    <div className="fd-placement-section">
                      <h3>Reserved space</h3>
                      <p>Keep room for mounting hardware or mechanical features.</p>
                      <button
                        className="fd-placement-wide"
                        disabled={blocked}
                        onClick={() =>
                          change((next) => {
                            next.reservedAreas ??= [];
                            next.reservedAreas.push({
                              id: crypto.randomUUID(),
                              name: `Reserved ${next.reservedAreas.length + 1}`,
                              x: next.board.x + next.board.w / 2 - 2.5,
                              y: next.board.y + next.board.h / 2 - 2.5,
                              w: 5,
                              h: 5,
                              margin: 0.25,
                              side: "both",
                            });
                          })
                        }
                      >
                        + Reserve an area
                      </button>
                      {session.reservedAreas?.map((a) => (
                        <details key={a.id}>
                          <summary>{a.name}</summary>
                          <label className="fd-placement-field">
                            <span>Name</span>
                            <input
                              key={a.id + a.name}
                              defaultValue={a.name}
                              maxLength={120}
                              disabled={blocked}
                              onBlur={(e) => {
                                if (e.target.value !== a.name)
                                  change((next) => {
                                    next.reservedAreas!.find((q) => q.id === a.id)!.name =
                                      e.target.value;
                                  });
                              }}
                            />
                          </label>
                          <div className="fd-placement-field-pair">
                            {(["x", "y", "w", "h", "margin"] as const).map((field) => (
                              <NumberField
                                key={field}
                                label={`${{ x: "X", y: "Y", w: "Width", h: "Height", margin: "Margin" }[field]} · mm`}
                                value={a[field]}
                                min={
                                  field === "w" || field === "h"
                                    ? 0.1
                                    : field === "margin"
                                      ? 0
                                      : -10000
                                }
                                max={field === "margin" ? 100 : 2000}
                                disabled={blocked}
                                onChange={(n) =>
                                  change((next) => {
                                    next.reservedAreas!.find((area) => area.id === a.id)![field] =
                                      n;
                                  })
                                }
                              />
                            ))}
                          </div>
                          <label className="fd-placement-field">
                            <span>Side</span>
                            <Select
                              value={a.side}
                              disabled={blocked}
                              onChange={(e) =>
                                change((next) => {
                                  next.reservedAreas!.find((area) => area.id === a.id)!.side = e
                                    .target.value as "F" | "B" | "both";
                                })
                              }
                            >
                              <option value="both">Both</option>
                              <option value="F">Front</option>
                              <option value="B">Back</option>
                            </Select>
                          </label>
                          <div className="fd-placement-button-grid">
                            <button
                              onClick={() => setFocus((f) => ({ ids: [a.id], nonce: f.nonce + 1 }))}
                            >
                              Locate area
                            </button>
                            <button
                              disabled={blocked}
                              onClick={() =>
                                change((next) => {
                                  next.reservedAreas = next.reservedAreas!.filter(
                                    (area) => area.id !== a.id,
                                  );
                                })
                              }
                            >
                              Remove area
                            </button>
                          </div>
                        </details>
                      ))}
                    </div>
                    <div className="fd-placement-section">
                      <h3>Optional spacing guidelines</h3>
                      <p>Advisory only. These do not push parts or count as overlaps.</p>
                      <label className="fd-placement-check">
                        <input
                          type="checkbox"
                          checked={session.spacingGuidelines.enabled}
                          disabled={blocked}
                          onChange={(e) =>
                            change((next) => {
                              next.spacingGuidelines.enabled = e.target.checked;
                            })
                          }
                        />
                        Show spacing targets
                      </label>
                      {session.spacingGuidelines.enabled && (
                        <div className="fd-placement-field-pair">
                          <NumberField
                            label="Courtyard · mm"
                            value={session.spacingGuidelines.courtyard}
                            min={0}
                            max={10}
                            disabled={blocked}
                            onChange={(n) =>
                              change((next) => {
                                next.spacingGuidelines.courtyard = n;
                              })
                            }
                          />
                          <NumberField
                            label="Board edge · mm"
                            value={session.spacingGuidelines.edge}
                            min={0}
                            max={10}
                            disabled={blocked}
                            onChange={(n) =>
                              change((next) => {
                                next.spacingGuidelines.edge = n;
                              })
                            }
                          />
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </aside>
          </div>
          <footer className="fd-placement-footer">
            <span>
              <i />
              {selection.length
                ? `${selection.length} selected`
                : `${session.parts.length} components`}
            </span>
            <button onClick={() => setInspector("review")}>
              {checking
                ? "Checking…"
                : `${analysis.findings.length} placement finding${analysis.findings.length === 1 ? "" : "s"}`}
            </button>
            <span>Draft workspace · source board unchanged</span>
          </footer>
        </>
      )}
      <Dialog
        open={exportOpen}
        onClose={() => {
          if (!busy) setExportOpen(false);
        }}
        title="Create a PCB copy from this layout"
      >
        <div className="fd-placement-dialog">
          <p>
            This creates a new KiCad file in your project's <strong>placement</strong> folder with
            the edited component positions.
          </p>
          <p>
            <strong>Tracks, vias and copper zones are removed.</strong> The schematic and original
            PCB are unchanged. This copy is not active in Routing or Checks. Inspect it in Files, or open it in a separate project before routing and running KiCad DRC.
          </p>
          <p>
            Groups, edge anchors, reserved areas and spacing guidelines are retained in the
            placement draft, not the exported PCB.
          </p>
          <div>
            <Button variant="secondary" disabled={!!busy} onClick={() => setExportOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!!busy} onClick={() => void exportPcb()}>
              {busy || (canvas ? "Create copy & continue…" : "Export unrouted copy")}
            </Button>
          </div>
        </div>
      </Dialog>
      <Dialog open={leaveOpen} title="Leave this preview?" onClose={() => setLeaveOpen(false)}><div className="fd-placement-dialog"><p>The preview has not been applied. Your earlier layout edits stay available when you return.</p><div><Button variant="secondary" onClick={() => setLeaveOpen(false)}>Keep reviewing</Button><Button onClick={() => { setPreview(null); useUiStore.getState().setBoardTab("pcb"); }}>Leave preview & return to PCB</Button></div></div></Dialog>
      <Dialog open={copyOpen} onClose={() => { if (!busy) setCopyOpen(false); }} title="Continue in a separate working copy">
        <div className="fd-placement-dialog"><p>Create a new project with the source files and local assets, then use the exported unrouted PCB in that copy. The original project stays unchanged.</p><p>Generated previews, reports and manufacturing outputs are excluded. Re-run routing and checks; copied files do not establish electrical compatibility or manufacturing readiness.</p>{exported && history && exported.revision !== history.revision && <p>This export comes from an earlier draft revision. Cancel and export again to include your latest edits.</p>}<label>Project name<Input aria-label="Placement working copy name" maxLength={80} value={copyName} disabled={!!busy} onChange={event => setCopyName(event.target.value)} /></label><div><Button variant="secondary" disabled={!!busy} onClick={() => setCopyOpen(false)}>Cancel</Button><Button variant="primary" disabled={!!busy || !copyName.trim()} onClick={() => void continueCopy()}>{busy || "Create copy & open routing"}</Button></div></div>
      </Dialog>
      <Dialog
        open={replaceOpen}
        onClose={() => setReplaceOpen(false)}
        title="Replace this placement draft?"
      >
        <div className="fd-placement-dialog">
          <p>
            {dirty
              ? "You have unsaved placement edits. Cancel and save the draft first if you want to keep them."
              : "The current layout will be replaced. Your saved draft and source files stay available in this project."}
          </p>
          <div>
            <Button variant="secondary" onClick={() => setReplaceOpen(false)}>
              Keep current draft
            </Button>
            <Button
              onClick={() => {
                setReplaceOpen(false);
                replacement.current?.();
                replacement.current = null;
              }}
            >
              Open selected file
            </Button>
          </div>
        </div>
      </Dialog>
      {library && session && (
        <FootprintLibrary
          target={session.parts.find((p) => p.id === library.target) ?? null}
          {...(library.initial ? { initial: library.initial } : {})}
          onClose={() => setLibrary(null)}
          onPreview={(entry) => {
            const target = library.target,
              at = library.at;
            setLibrary(null);
            void propose(
              target
                ? { kind: "replace", session, id: target, text: entry.text, name: entry.name }
                : {
                    kind: "add",
                    session,
                    text: entry.text,
                    name: entry.name,
                    ...(at ? { at } : {}),
                  },
              target ? "Replace footprint" : "Add footprint",
            );
          }}
        />
      )}
      {enclosure && history && (
        <PlacementEnclosure
          projectId={projectId}
          session={history.present}
          onClose={() => setEnclosure(false)}
        />
      )}
      <Dialog open={help} onClose={() => setHelp(false)} title="Place components with confidence">
        <div className="fd-placement-dialog">
          <p>
            <strong>1. Arrange.</strong> Click a component or use the Parts list. Drag it to move,
            Shift-click or box-select several, and lock anything that must stay fixed. Push
            neighbors moves neighbors on boards up to 200 parts; larger boards can use overlap
            cleanup.
          </p>
          <p>
            <strong>2. Review.</strong> Open Layout checks to inspect geometric findings or preview a
            better layout. Apply accepts the whole preview; Cancel keeps your layout.
          </p>
          <p>
            <strong>3. Save.</strong> Save layout keeps your work across restarts. Export PCB creates
            an unrouted copy for routing and DRC. Unsaved edits survive tab switches, but save
            before closing the app.
          </p>
          <dl>
            <dt>Scroll</dt>
            <dd>Zoom toward the pointer</dd>
            <dt>Space + drag / middle drag</dt>
            <dd>Pan the board</dd>
            <dt>Arrow keys · Shift + arrows</dt>
            <dd>Nudge · larger nudge</dd>
            <dt>R · F · Home</dt>
            <dd>Rotate · focus selection · fit board</dd>
            <dt>Ctrl/Cmd + Z · Shift + Z</dt>
            <dd>Undo · redo</dd>
          </dl>
          <Button onClick={() => setHelp(false)}>Got it</Button>
        </div>
      </Dialog>
    </section>
  );
}
