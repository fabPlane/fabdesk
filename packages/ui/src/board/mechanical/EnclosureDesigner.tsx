import { useEffect, useRef, useState } from "react";
import {
  MechanicalDesignSchema,
  type MechanicalDesign,
  type MechanicalFitReport,
  type MechanicalFitIssue,
} from "@fabdesk/protocol";
import {
  useCoreClient,
  defaultEnclosureDesign,
  decodeMesh,
  mechanicalItem,
  enclosureErrorMessage,
  enclosureFileLabel,
  type EnclosureBoardSummary,
} from "@fabdesk/client-core";
import { MechanicalScene, type SceneModel, type BoardGeometry } from "./MechanicalScene";
import { EnclosureFitReview } from "./EnclosureFitReview";

type Result = {
  design?: MechanicalDesign | null;
  designRevision?: string | null;
  board?: EnclosureBoardSummary | null;
  capabilities?: { pcb: boolean; cad: boolean };
  revision?: string;
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
const steps = ["Start", "Space", "PCB", "Review"] as const;
type Step = (typeof steps)[number];
function NumberField({
  label,
  inputLabel,
  value,
  onChange,
  min = -10000,
  unit = "mm",
}: {
  label: string;
  inputLabel?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  unit?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <label className="fd-case-number">
      <span>{label}</span>
      <div>
        <input
          aria-label={inputLabel ?? label}
          type="number"
          step="0.1"
          min={min}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (e.target.value.trim() && Number.isFinite(e.target.valueAsNumber))
              onChange(e.target.valueAsNumber);
          }}
          onBlur={() => {
            if (!draft.trim() || !Number.isFinite(Number(draft))) setDraft(String(value));
          }}
        />
        <span>{unit}</span>
      </div>
    </label>
  );
}
/** Guided enclosure workflow; all preview coordinates are in the saved PCB frame, in mm. */
export function EnclosureDesigner({ projectId }: { projectId: string }) {
  const client = useCoreClient();
  const [design, setDesign] = useState<MechanicalDesign | null>(null),
    [board, setBoard] = useState<EnclosureBoardSummary | null>(null);
  const [step, setStep] = useState<Step>("Start"),
    [files, setFiles] = useState<string[]>([]);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false),
    [preview, setPreview] = useState<Result | null>(null),
    [report, setReport] = useState<MechanicalFitReport | null>(null);
  const [archive, setArchive] = useState<string | null>(null),
    [component, setComponent] = useState(""),
    [move, setMove] = useState({ x: 0, y: 0, rotation: 0 });
  const [hole, setHole] = useState({ x: 0, y: 0, diameter: 3 }),
    [editReview, setEditReview] = useState<"outline" | "move" | "hole" | null>(null);
  const revision = useRef<string | null>(null),
    scene = useRef<MechanicalScene | null>(null),
    host = useRef<HTMLDivElement>(null);
  const mounted = useRef(true),
    running = useRef(false),
    importInput = useRef<HTMLInputElement>(null);
  const [modelSources, setModelSources] = useState<SceneModel[]>([]);
  const [fitBoards, setFitBoards] = useState<Result["boards"]>(undefined);
  const [fitState, setFitState] = useState(""),
    [fitError, setFitError] = useState("");
  const [showRisks, setShowRisks] = useState(true),
    [showSpace, setShowSpace] = useState(true);
  const [focusedIssue, setFocusedIssue] = useState<MechanicalFitIssue | null>(null);
  const sourceBuffers = useRef(new Map<string, ArrayBuffer>());
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [step, error]);
  const [capabilities, setCapabilities] = useState({ pcb: false, cad: false });
  const [openLid, setOpenLid] = useState(true),
    [transparent, setTransparent] = useState(false);
  useEffect(() => {
    scene.current?.setExplode(openLid ? 25 : 0);
  }, [openLid, modelSources]);
  useEffect(() => {
    scene.current?.setTranslucent(transparent);
  }, [transparent, modelSources]);
  async function call(action: string, extra: Record<string, unknown> = {}) {
    return unpack(await client.callTool("cad_fit", { projectId, action, ...extra }));
  }
  // Debounce edits; old responses never paint a newer design or replace a preview's report.
  useEffect(() => {
    if (!design || preview || busy) return;
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
  }, [design, board, preview, busy, client, projectId]);
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
      setDesign(
        r.design ? MechanicalDesignSchema.parse(r.design) : defaultEnclosureDesign(r.board ?? null),
      );
      setFiles(p.files.map((f) => f.path));
    });
    return () => {
      mounted.current = false;
    };
  }, [projectId]);
  useEffect(() => {
    if (!host.current) return;
    try {
      const s = new MechanicalScene(host.current, {
        select: () => {},
        transform: () => {},
        measured: () => {},
        zoom: () => {},
        error: setError,
      });
      scene.current = s;
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
      ?.setModels(modelSources)
      .then(() => {
        if (!cancel) scene.current?.fit();
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancel = true;
    };
  }, [modelSources]);
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
          : (report?.issues.filter((i) => i.severity === "error").flatMap((i) => i.regions ?? []) ??
            [])
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
    }));
    const knownBoards = new Map((fitBoards ?? []).map((b) => [b.placement.path, b.features]));
    if (board && !knownBoards.has("board.kicad_pcb")) knownBoards.set("board.kicad_pcb", board);
    for (const placement of design.boards) {
      const features = knownBoards.get(placement.path);
      if (!features) continue;
      const item = mechanicalItem(`@current-${placement.path}`, "board", "PCB envelope");
      item.position = [placement.x, placement.y, placement.z];
      item.rotation = [0, 0, placement.rotation];
      models.push({
        item,
        board: {
          outline: features.outline,
          holes: features.holes,
          parts: features.components ?? [],
          connectors: features.connectors ?? [],
        },
        thickness: features.thicknessMm,
        origin: [0, 0, 0],
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
          sourceBuffers.current.set(source.path, data);
        }
        const item = {
          ...mechanicalItem(source.path, "import", "Original enclosure"),
          position: source.position,
          rotation: source.rotation,
          scale: source.scale,
        };
        if (!cancelled) setModelSources([...models, { item, data, origin: [0, 0, 0] }]);
      })().catch((e) => {
        if (!cancelled) setError(enclosureErrorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [design, board, fitBoards, preview, client, projectId]);
  const edit = (next: MechanicalDesign) => {
    setDesign(next);
    setDirty(true);
    setPreview(null);
    setReport(null);
    setFocusedIssue(null);
    setArchive(null);
    setEditReview(null);
    setNotice("");
    setModelSources([]);
  };
  function space(key: keyof MechanicalDesign["space"], value: number) {
    if (design) edit({ ...design, confirmed: false, space: { ...design.space, [key]: value } });
  }
  async function save() {
    const parsed = MechanicalDesignSchema.parse(design);
    const r = await call("save", { design: parsed, expectedDesignRevision: revision.current });
    if (!mounted.current) return;
    revision.current = r.designRevision ?? null;
    setDirty(false);
    setNotice("Settings saved in this project.");
  }
  async function showPreview() {
    if (!design) return;
    await save();
    const r = await call("preview", { design });
    if (!mounted.current) return;
    setPreview(r);
    setReport(r.report ?? null);
    setFitError("");
    setFitState("Fit checked with preview");
    setFocusedIssue(null);
    const models: SceneModel[] = design.obstacles.map((volume, i) => ({
      item: mechanicalItem(`@obstacle-${i}`, "import", volume.name),
      volume,
      origin: [0, 0, 0],
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
          });
      }
    for (const b of r.boards ?? []) {
      const item = mechanicalItem(`@fit-${b.placement.path}`, "board", b.placement.path);
      item.position = [b.placement.x, b.placement.y, b.placement.z];
      item.rotation = [0, 0, b.placement.rotation];
      models.push({
        item,
        board: {
          outline: b.features.outline,
          holes: b.features.holes,
          parts: b.features.components ?? [],
          connectors: b.features.connectors ?? [],
        } as BoardGeometry,
        thickness: b.features.thicknessMm,
        origin: [0, 0, 0],
      });
    }
    setModelSources(models);
    setNotice("Preview only. Apply when the dimensions and fit review look right.");
    setStep("Review");
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
    setNotice("Enclosure and PCB snapshot saved together. Ready to download.");
  }
  async function applyEdit() {
    if (!design || !board || !editReview) return;
    const placement = design.boards.find((b) => b.path === "board.kicad_pcb");
    if (!placement || placement.rotation !== 0)
      throw new Error(
        "Set the project PCB rotation to 0° before using rectangular outline editing.",
      );
    const s = design.space,
      c = s.clearance;
    const x = s.x + c - placement.x,
      y = s.y + c - placement.y,
      w = s.width - 2 * c,
      h = s.depth - 2 * c;
    const change =
      editReview === "outline"
        ? {
            outline: [
              { x, y },
              { x: x + w, y },
              { x: x + w, y: y + h },
              { x, y: y + h },
            ],
          }
        : editReview === "move"
          ? { footprints: [{ reference: component, position: { x: move.x, y: move.y } }] }
          : { holes: [hole] };
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
  const field = (key: keyof MechanicalDesign["space"], label: string, min = 0.1) => (
    <NumberField
      label={label}
      value={design!.space[key]}
      min={min}
      onChange={(v) => space(key, v)}
    />
  );
  const actionsDisabled = !!busy || !design;
  return (
    <section className="fd-case-workflow" aria-label="Enclosure designer">
      <div className="fd-case-canvas" ref={host} />
      <aside className="fd-case-panel">
        <header>
          <div>
            <span className="fd-case-eyebrow">ENCLOSURE DESIGN</span>
            <h2>A case that fits</h2>
          </div>
          <small role="status">{dirty ? "Unsaved changes" : "Project settings"}</small>
        </header>
        <nav aria-label="Enclosure workflow">
          {steps.map((s) => (
            <button
              key={s}
              aria-current={step === s ? "step" : undefined}
              disabled={!!busy}
              onClick={() => setStep(s)}
            >
              {s}
            </button>
          ))}
        </nav>
        <div className="fd-case-body" ref={body}>
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
            <fieldset disabled={!!busy} className="fd-case-fields">
              {step === "Start" && (
                <>
                  <h3>What are you starting with?</h3>
                  <p>
                    Create a case around your boards, or make room inside an existing enclosure.
                  </p>
                  <div className="fd-case-choices">
                    <button
                      aria-pressed={design.mode === "generated"}
                      onClick={() => edit({ ...design, mode: "generated", confirmed: false })}
                    >
                      <strong>New enclosure</strong>
                      <small>Generate a base and lid</small>
                    </button>
                    <button
                      aria-pressed={design.mode === "imported"}
                      onClick={() => edit({ ...design, mode: "imported", confirmed: false })}
                    >
                      <strong>Existing case</strong>
                      <small>Keep the original; edit a copy</small>
                    </button>
                  </div>
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
                  <h3>Usable inside dimensions</h3>
                  <p>Measure inside the walls. All dimensions are millimetres.</p>
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
                  <label className="fd-case-check">
                    <input
                      type="checkbox"
                      checked={design.confirmed}
                      onChange={(e) => edit({ ...design, confirmed: e.target.checked })}
                    />
                    I have confirmed the units and interior dimensions
                  </label>
                </>
              )}
              {step === "Space" && (
                <>
                  <h3>Leave room for the real parts</h3>
                  <p>Add space occupied by batteries, hinges and other fixed parts.</p>
                  {field("clearance", "Minimum clearance", 0)}
                  <details open={design.obstacles.length > 0}>
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
                    <summary>Mounting points · {design.mounts.length}</summary>
                    <p>
                      Creates screw posts in the case. Matching PCB holes are checked separately.
                    </p>
                    {design.mounts.map((m, i) => (
                      <div className="fd-case-entry" key={i}>
                        <strong>Mount {i + 1}</strong>
                        <div className="fd-case-grid">
                          {(["x", "y", "diameter", "outer", "height"] as const).map((k) => (
                            <NumberField
                              key={k}
                              label={`Mount ${i + 1} ${{ x: "X", y: "Y", diameter: "hole diameter", outer: "post diameter", height: "height" }[k]}`}
                              value={m[k]}
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
                        <button
                          onClick={() =>
                            edit({ ...design, mounts: design.mounts.filter((_, j) => j !== i) })
                          }
                        >
                          Remove mount
                        </button>
                      </div>
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
                </>
              )}
              {step === "PCB" && (
                <>
                  <h3>Fit your boards</h3>
                  <p>
                    Board positions below place them inside the enclosure. The editing controls
                    change the actual project PCB.
                  </p>
                  {design.boards.map((b, i) => (
                    <details key={i} open>
                      <summary title={b.path}>
                        {b.path === "board.kicad_pcb" ? "Project PCB" : enclosureFileLabel(b.path)}
                      </summary>
                      <div className="fd-case-grid">
                        {(["x", "y", "z", "rotation"] as const).map((k) => (
                          <NumberField
                            key={k}
                            label={
                              {
                                x: "Left / right (X)",
                                y: "Front / back (Y)",
                                z: "Height (Z)",
                                rotation: "Rotation",
                              }[k]
                            }
                            inputLabel={`Board ${i + 1} ${k}`}
                            unit={k === "rotation" ? "°" : "mm"}
                            value={b[k]}
                            onChange={(v) =>
                              edit({
                                ...design,
                                boards: design.boards.map((p, j) =>
                                  j === i ? { ...p, [k]: v } : p,
                                ),
                              })
                            }
                          />
                        ))}
                      </div>
                      <button
                        onClick={() =>
                          edit({ ...design, boards: design.boards.filter((_, j) => j !== i) })
                        }
                      >
                        Remove from enclosure
                      </button>
                    </details>
                  ))}
                  <label>
                    Add a PCB
                    <select
                      aria-label="Add a PCB"
                      value=""
                      onChange={(e) => {
                        if (e.target.value)
                          edit({
                            ...design,
                            boards: [
                              ...design.boards,
                              {
                                path: e.target.value,
                                x: 0,
                                y: 0,
                                z: design.space.floor + 3,
                                rotation: 0,
                              },
                            ],
                          });
                      }}
                    >
                      <option value="">Choose project board…</option>
                      {files
                        .filter(
                          (p) =>
                            p.endsWith(".kicad_pcb") && !design.boards.some((b) => b.path === p),
                        )
                        .map((p) => (
                          <option key={p}>{p}</option>
                        ))}
                    </select>
                  </label>
                  {board && design.boards.some((b) => b.path === "board.kicad_pcb") && (
                    <details>
                      <summary>Edit actual project PCB</summary>
                      <p>
                        Changes board.kicad_pcb. Existing tracks are preserved; rerouting and
                        electrical DRC may be needed.
                      </p>
                      {!capabilities.pcb && (
                        <p className="fd-case-message">
                          Connect the FabPlane PCB backend to apply board edits. Fit checks and
                          enclosure generation are available now.
                        </p>
                      )}
                      <button onClick={() => setEditReview("outline")}>
                        Size board outline to interior
                      </button>
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
                      <div className="fd-case-grid">
                        {(["x", "y", "diameter"] as const).map((k) => (
                          <NumberField
                            key={k}
                            label={`PCB hole ${k}`}
                            value={hole[k]}
                            onChange={(v) => {
                              setHole({ ...hole, [k]: v });
                              setEditReview(null);
                            }}
                          />
                        ))}
                      </div>
                      <button onClick={() => setEditReview("hole")}>Review mounting hole</button>
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
                            disabled={!capabilities.pcb}
                            onClick={() => void run("Saving PCB edit…", applyEdit)}
                          >
                            Apply PCB edit
                          </button>
                          <button onClick={() => setEditReview(null)}>Cancel</button>
                        </div>
                      )}
                    </details>
                  )}
                </>
              )}
              {step === "Review" && (
                <>
                  <h3>Check before you export</h3>
                  <p>
                    {design.mode === "generated"
                      ? "Preview the base and lid around your boards."
                      : "Preview a modified copy of your imported case."}
                  </p>
                  <button
                    onClick={() =>
                      void run("Checking clearances…", async () => {
                        const r = await call("check", { design });
                        setFocusedIssue(null);
                        setFitBoards(r.boards);
                        setFitError("");
                        setFitState("Fit checked");
                        if (preview && r.revision !== preview.revision) {
                          setPreview(null);
                          setArchive(null);
                          setNotice("The design changed. Preview again before applying.");
                        }
                        setReport(r.report ?? null);
                      })
                    }
                  >
                    Check fit
                  </button>
                  <p className="fd-case-fit-state" role="status">
                    {preview ? "Fit checked with preview" : fitState}
                  </p>
                  {fitError && (
                    <p role="alert" className="fd-case-message is-error">
                      {fitError}
                    </p>
                  )}
                  {report && (
                    <EnclosureFitReview
                      report={report}
                      onNavigate={setStep}
                      onShowIssue={showIssue}
                      focusedIssue={focusedIssue}
                    />
                  )}
                  {!preview && (
                    <p className="fd-case-hint">
                      Next: preview your case. If you change the design, preview it again before
                      applying.
                    </p>
                  )}
                  {preview && (
                    <button
                      onClick={() => {
                        setPreview(null);
                        setModelSources([]);
                        setArchive(null);
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
          <span role="status">
            {busy ||
              (preview
                ? "Preview ready"
                : design?.confirmed
                  ? "Dimensions confirmed"
                  : "Confirm dimensions to preview")}
          </span>
          <div>
            {step !== "Start" && (
              <button
                className="fd-case-back"
                disabled={actionsDisabled}
                onClick={() => setStep(steps[steps.indexOf(step) - 1]!)}
              >
                Back
              </button>
            )}
            <button
              disabled={actionsDisabled || !dirty}
              onClick={() => void run("Saving settings…", save)}
            >
              Save
            </button>
            {step !== "Review" ? (
              <button
                className="fd-mechanical-primary"
                disabled={actionsDisabled}
                onClick={() => setStep(steps[steps.indexOf(step) + 1]!)}
              >
                {step === "Start" ? "Next: space" : step === "Space" ? "Next: PCB" : "Next: review"}
              </button>
            ) : archive ? (
              <button
                className="fd-mechanical-primary"
                disabled={actionsDisabled}
                onClick={() => void run("Preparing download…", () => download(archive))}
              >
                Download design ZIP
              </button>
            ) : preview ? (
              <button
                className="fd-mechanical-primary"
                disabled={actionsDisabled || report?.status === "blocked"}
                onClick={() => void run("Saving matched designs…", build)}
              >
                Apply & prepare export
              </button>
            ) : (
              <button
                className="fd-mechanical-primary"
                disabled={actionsDisabled || !design?.confirmed}
                onClick={() => void run("Building enclosure preview…", showPreview)}
              >
                Preview enclosure
              </button>
            )}
          </div>
        </footer>
      </aside>
      <div className="fd-case-hud">
        <div className="fd-case-view-tools">
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
        <div className="fd-case-fit-legend" aria-label="Fit overlay legend">
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
      <div className="fd-case-canvas-note">
        <strong>
          {preview
            ? "Enclosure preview"
            : design?.mode === "imported" && design.source
              ? "Original enclosure · Unchanged"
              : "PCB reference"}
        </strong>
        <span>
          {preview
            ? "Drag to rotate · Scroll to zoom · Right-drag to pan"
            : "Set your space, then choose Preview enclosure."}
        </span>
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
          if (!file || !design) return;
          void run("Importing enclosure…", async () => {
            if (file.size > 50 * 1024 * 1024)
              throw new Error("Choose an enclosure smaller than 50 MB.");
            const path = `cad/imports/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
            await client.writeFile(projectId, path, file);
            setFiles((f) => [...f, path]);
            edit({
              ...design,
              confirmed: false,
              source: { path, scale: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
            });
          });
        }}
      />
    </section>
  );
}
