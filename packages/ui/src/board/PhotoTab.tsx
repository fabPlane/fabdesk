import { useEffect, useState } from "react";
import type { PhotoSighting } from "@fabdesk/protocol";
import { Button, EmptyState, Input, LoadError, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import {
  useContinuePhoto,
  useCore,
  usePhoto,
  useProjectText,
  useSavePhotoSighting,
} from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { WhatISeeTable } from "./WhatISeeTable";

export function PhotoTab() {
  const projectId = useUiStore((s) => s.activeProjectId);
  const { client } = useCore();
  const photo = usePhoto(projectId);
  const pcbSvg = useProjectText(projectId, "renders/pcb.svg");
  const save = useSavePhotoSighting();
  const cont = useContinuePhoto();
  const [draft, setDraft] = useState<PhotoSighting | null>(null);
  const [widthMm, setWidthMm] = useState("");
  const [heightMm, setHeightMm] = useState("");

  const sighting = draft ?? photo.data?.sighting ?? null;
  useEffect(() => {
    const next = photo.data?.sighting ?? null;
    setDraft(next);
    if (next) {
      setWidthMm(String(next.scale.boardWidthMm));
      setHeightMm(String(next.scale.boardHeightMm));
    }
  }, [photo.data?.sighting]);

  if (!projectId) {
    return <EmptyState title="No project">Create a project and drop a photo to start.</EmptyState>;
  }
  if (photo.isPending) return <div className="p-6"><Spinner /></div>;
  if (photo.isError) return <LoadError title="Could not load the photo draft" onRetry={() => void photo.refetch()} />;
  if (!sighting) {
    return (
      <EmptyState
        icon={<Icon name="image" width={36} height={36} />}
        title="Start from a photo"
      >
        Drop photos on the chat, or use Start from a photo when creating a project. The draft is a
        functional equivalent — not a copy of the original traces.
      </EmptyState>
    );
  }

  const applyScale = () => {
    const w = Number(widthMm);
    const h = Number(heightMm);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
    const sx = w / sighting.scale.boardWidthMm;
    const sy = h / sighting.scale.boardHeightMm;
    setDraft({
      ...sighting,
      scale: {
        ...sighting.scale,
        method: "user_dimension",
        userDimensionMm: w,
        userDimensionOf: "width",
        assumedMmPerPx: sighting.scale.assumedMmPerPx * sx,
        boardWidthMm: w,
        boardHeightMm: h,
        note: `Using the width you gave (${w} mm) as the scale.`,
        confidence: 0.9,
      },
      outline: {
        ...sighting.outline,
        source: "user",
        polygon: sighting.outline.polygon.map((p) => ({ x: p.x * sx, y: p.y * sy })),
      },
    });
  };

  const persist = async () => {
    if (!draft) return;
    await save.mutateAsync({ projectId, sighting: draft });
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-4" data-testid="photo-tab">
      <div>
        <div className="text-[13px] font-semibold">Reference photo vs draft board</div>
        <p className="mt-1 text-xs leading-5 text-muted">{sighting.equivalentDisclaimer}</p>
        {sighting.openSourceNote?.suspected && (
          <p className="mt-1 text-xs leading-5 text-warning">
            These photos may show a known open-source design
            {sighting.openSourceNote.projectName ? ` (${sighting.openSourceNote.projectName})` : ""}.
            Attribute the original authors. This draft is not that design.
          </p>
        )}
      </div>
      <div className="grid min-h-[220px] gap-3 md:grid-cols-2">
        <figure className="rounded-xl border border-border bg-panel-2/40 p-2">
          <figcaption className="mb-2 text-[11px] uppercase tracking-wide text-muted">Reference</figcaption>
          <div className="flex flex-wrap gap-2">
            {sighting.photos.map((photoRef) => (
              <img
                key={photoRef.path}
                src={client.fileUrl(projectId, photoRef.path)}
                alt={`${photoRef.side} reference photo`}
                className="max-h-56 max-w-full rounded-lg object-contain"
              />
            ))}
          </div>
        </figure>
        <figure className="rounded-xl border border-border bg-panel-2/40 p-2">
          <figcaption className="mb-2 text-[11px] uppercase tracking-wide text-muted">Draft board</figcaption>
          {pcbSvg.data ? (
            <div className="max-h-56 overflow-hidden" dangerouslySetInnerHTML={{ __html: pcbSvg.data }} />
          ) : (
            <p className="text-xs text-muted">
              No PCB render yet. Continue the draft, then open the PCB tab to render it.
            </p>
          )}
        </figure>
      </div>
      <div className="rounded-xl border border-border p-3">
        <div className="mb-2 text-[13px] font-semibold">Scale and outline</div>
        <p className="mb-2 text-xs text-muted">{sighting.scale.note}</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs">
            Width mm
            <Input className="mt-1 w-24" value={widthMm} onChange={(e) => setWidthMm(e.target.value)} />
          </label>
          <label className="text-xs">
            Height mm
            <Input className="mt-1 w-24" value={heightMm} onChange={(e) => setHeightMm(e.target.value)} />
          </label>
          <Button size="sm" onClick={applyScale}>Apply size</Button>
          <span className="text-[11px] text-muted">
            Outline: {sighting.outline.polygon.length} points ({sighting.outline.source})
          </span>
        </div>
      </div>
      <div className="rounded-xl border border-border p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-[13px] font-semibold">What I see</div>
          <div className="flex gap-2">
            <Button size="sm" disabled={!draft || save.isPending} onClick={() => void persist()}>
              {save.isPending ? "Saving…" : "Save corrections"}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={cont.isPending}
              onClick={() => void persist().then(() => cont.mutateAsync({ projectId, acceptSighting: true }))}
            >
              {cont.isPending ? "Drafting…" : "Draft the board"}
            </Button>
          </div>
        </div>
        <WhatISeeTable sighting={sighting} onChange={setDraft} />
      </div>
    </div>
  );
}
