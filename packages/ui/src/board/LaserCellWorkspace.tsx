/**
 * "Laser cell" workspace. The controller lives in its own desktop window (Laser Controller); this view opens
 * it for the current project. Without a desktop window (browser client) the controller is shown inline.
 * The controller UI itself: ../laser/LaserController.tsx.
 */
import { useCore, useLaserCell } from "@fabdesk/client-core";
import { useState } from "react";
import { Button, EmptyState } from "../components/ui";
import { useAssistantSurface } from "../chat/useAssistantSurface";
import { LaserController, setLaserProject } from "../laser/LaserController";

export function LaserCellWorkspace({ projectId }: { projectId: string }) {
  const { host } = useCore();
  const cell = useLaserCell();
  const snap = cell.data;
  const [error, setError] = useState<string | null>(null);
  useAssistantSurface(snap ? {
    projectId,
    label: "Laser cell",
    priority: 4,
    details: JSON.stringify({ arm: snap.arm.connected, laser: snap.laser?.state, driver: snap.config.laser.driver, missing: snap.missing, run: snap.run, safetyConfirmed: snap.config.safetyConfirmed }),
  } : null);
  const openWindow = host.openLaserWindow;
  if (!openWindow) {
    setLaserProject(projectId);
    return <LaserController inline />;
  }
  const open = () => {
    setError(null);
    setLaserProject(projectId);
    openWindow().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return <div className="flex h-full items-center justify-center p-6" data-testid="laser-cell-workspace">
    <EmptyState
      title="Laser Controller"
      action={<Button variant="primary" onClick={open}>Open Laser Controller</Button>}
    >
      Make the copper job for this board, load it into ComMarker Studio, and run the laser and the robot arm, in a window of its own that can stay open next to Studio.
      {snap?.run.active ? ` Running: board ${snap.run.board} of ${snap.run.boards}.` : ""}
      {error ? <span className="block text-danger">{error}</span> : null}
    </EmptyState>
  </div>;
}
