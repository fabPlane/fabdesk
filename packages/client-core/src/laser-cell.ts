/** Client access to the laser cell (`laser_cell` / `export_laser_copper` tools). Shapes mirror @fabdesk/laser-cell. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { CoreClient } from "./CoreClient";
import { pcbToolJson } from "./pcb-parts";
import { useCoreClient } from "./provider";

export type LaserCellPoseName = "home" | "stackAbove" | "stackPick" | "jigAbove" | "jigPlace" | "clear" | "trayAbove" | "trayPlace";
export type LaserCellTeachName = LaserCellPoseName | "gripperOpen" | "gripperClosed";
export type LaserCellDriver = "studio-window" | "studio-footswitch" | "lightburn" | "usb-lmc" | "simulator";

/** fabPlane's own USB driver for BJJCZ boards (experimental). */
export type LaserCellLmcConfig = {
  fieldMm: number;
  centerMm: { x: number; y: number };
  flipX: boolean;
  flipY: boolean;
  swapXY: boolean;
  source: "co2" | "fiber";
  laserPin: number;
  lightPin: number;
  maxPowerPct: number;
  initBoard: boolean;
  usbIndex: number;
  connection: "usb" | "network";
  host: string;
  port: number;
  token: string;
};
export type LaserCellRunMode = "cycle" | "dry-run" | "laser-only";

export type LaserCellConfig = {
  arm: { port: string | null; baud: number; jointIds: number[]; gripperId: number; speed: number; approachSpeed: number };
  laser: {
    driver: LaserCellDriver;
    studioCompletion: "watch" | "timer";
    studioExe: string | null;
    studioBoardCenterMm: { x: number; y: number };
    relayKind: "lcus" | "arduino";
    relayPort: string | null;
    relayChannel: number;
    markSeconds: number;
    marginSeconds: number;
    jobPath: string | null;
    lightburnHost: string;
    frameSeconds: number;
    markTimeoutMinutes: number;
    lmc: LaserCellLmcConfig;
  };
  poses: Partial<Record<LaserCellPoseName, Record<string, number>>> & { gripperOpen?: number; gripperClosed?: number };
  safetyConfirmed: boolean;
};

export type LaserCellSnapshot = {
  config: LaserCellConfig;
  configPath: string;
  arm: {
    connected: boolean;
    port: string | null;
    joints: Array<{ id: number; position: number; temperature: number; voltage: number; load: number; moving: boolean }> | null;
    error: string | null;
  };
  laser: { state: "idle" | "busy" | "error" | "offline"; detail: string; driver: string } | null;
  poses: Array<{ name: LaserCellPoseName; label: string; taught: boolean }>;
  missing: string[];
  run: {
    active: boolean;
    mode: LaserCellRunMode | null;
    step: string | null;
    visited: string[];
    note: string | null;
    progress: number;
    board: number;
    boards: number;
    done: number;
    startedAt: string | null;
    error: string | null;
    /** fabPlane USB driver: the job is paused (Resume continues it). */
    paused?: boolean;
    /** Estimated seconds left of the current laser job, when known. */
    remainingSeconds?: number | null;
    /** Pause can work right now. */
    pausable?: boolean;
  };
  log: Array<{ at: string; level: "info" | "warn" | "error"; message: string }>;
  /** A non-run operation in progress (loading into Studio, preview, arm move); Stop ends it. */
  operation: string | null;
};

export const LASER_CELL_KEY = "laser-cell";

/** Laser job (fabPlane USB / Wi-Fi driver): fill and outline settings. Mirrors @fabdesk/laser-cell job-file.ts. */
export type LaserJobSettings = { powerPct: number; speedMmPerS: number; frequencyKhz: number; passes: number; intervalMm: number; angleDeg: number; angleStepDeg: number };
export type LaserEdgeSettings = { powerPct: number; speedMmPerS: number; frequencyKhz: number; passes: number };
export type LaserJobView = {
  name: string;
  source: "board" | "file";
  boardMm: { width: number; height: number };
  positionMm: { x: number; y: number };
  positionFromJob: boolean;
  fieldMm: number;
  settings: LaserJobSettings;
  edge: LaserEdgeSettings | null;
  estimatedSeconds: number;
  preview: { fills: Array<Array<[number, number]>>; lines: Array<Array<[number, number]>> };
  warnings: string[];
};
export type LaserMaterialPreset = { id: string; label: string; settings: LaserJobSettings; edge?: LaserEdgeSettings };
export type LaserJobResponse = { job: LaserJobView | null; presets: LaserMaterialPreset[]; error?: string };

/** The cycle's steps in order, for the progress strip. */
export const LASER_CELL_STEPS: ReadonlyArray<{ step: string; label: string }> = [
  { step: "preflight", label: "Check" },
  { step: "pick", label: "Pick" },
  { step: "place", label: "Place" },
  { step: "clear", label: "Clear" },
  { step: "frame", label: "Frame" },
  { step: "mark", label: "Laser" },
  { step: "unload", label: "Unload" },
  { step: "done", label: "Done" },
];

export const LASER_DRIVER_LABELS: Record<LaserCellDriver, string> = {
  "studio-window": "ComMarker Studio (fabPlane presses Start in Studio)",
  "studio-footswitch": "ComMarker Studio (USB relay on the foot switch)",
  lightburn: "LightBurn (UDP automation)",
  "usb-lmc": "fabPlane USB driver (experimental)",
  simulator: "Simulator (no laser)",
};

async function callCell<T>(client: CoreClient, tool: string, args: Record<string, unknown>): Promise<T> {
  const call = await client.callTool(tool, args);
  const job = call.jobId ? await client.waitJob(call.jobId) : null;
  if (job && job.status !== "done") throw new Error(job.error ?? "The laser cell could not finish that.");
  return pcbToolJson(job ? job.result : call) as unknown as T;
}

/** Live cell status: polls fast while a run is active, slowly otherwise. */
export function useLaserCell() {
  const client = useCoreClient();
  return useQuery({
    queryKey: [LASER_CELL_KEY, "status"],
    queryFn: () => callCell<LaserCellSnapshot>(client, "laser_cell", { action: "status" }),
    refetchInterval: query => (query.state.data?.run.active || query.state.data?.operation ? 1000 : 3000),
    retry: false,
  });
}

export function useSerialPorts(enabled: boolean) {
  const client = useCoreClient();
  return useQuery({
    queryKey: [LASER_CELL_KEY, "ports"],
    queryFn: async () => (await callCell<{ ports: Array<{ path: string; label: string }> }>(client, "laser_cell", { action: "ports" })).ports,
    enabled,
    staleTime: 10_000,
  });
}

/** The current laser job with its preview and the material presets (fabPlane USB / Wi-Fi driver). */
export function useLaserJob(enabled: boolean) {
  const client = useCoreClient();
  return useQuery({
    queryKey: [LASER_CELL_KEY, "job"],
    queryFn: () => callCell<LaserJobResponse>(client, "laser_cell", { action: "job_view" }),
    enabled,
    retry: false,
  });
}

/** Run one laser-cell action and refresh the status (and the job, which an action may have changed). */
export function useLaserCellAction() {
  const client = useCoreClient(), queryClient = useQueryClient();
  return useCallback(async <T = LaserCellSnapshot>(args: Record<string, unknown>, tool = "laser_cell"): Promise<T> => {
    try {
      return await callCell<T>(client, tool, args);
    } finally {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [LASER_CELL_KEY, "status"] }),
        queryClient.invalidateQueries({ queryKey: [LASER_CELL_KEY, "job"] }),
      ]);
    }
  }, [client, queryClient]);
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), rest = s % 60;
  if (m < 60) return rest ? `${m} min ${rest} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
