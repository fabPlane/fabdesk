import { bomCurrency } from "@fabdesk/board-workflow";
/**
 * What the release stage keeps under `<project>/.fabdesk/board/release/`: the latest BOM check (decisions, JLC rotation
 * predictions, evidence cache), tied to the board it was made on, and the last fabrication package built.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const releaseHome = (projectDir: string) => join(projectDir, ".fabdesk", "board", "release");
export const bomDirOf = (projectDir: string) => join(releaseHome(projectDir), "bom");

export type BomMeta = { at: string; boardSha256: string; stem: string; boards: number; offline: boolean; summary: Record<string, number>; lines: number; placements: number };

export const sha256Of = async (path: string): Promise<string | null> => {
  const b = await readFile(path).catch(() => null);
  return b ? createHash("sha256").update(b).digest("hex") : null;
};

export async function writeBomMeta(projectDir: string, meta: BomMeta): Promise<void> {
  await mkdir(bomDirOf(projectDir), { recursive: true });
  await writeFile(join(bomDirOf(projectDir), "bom-meta.json"), JSON.stringify(meta, null, 1) + "\n");
}

/** The latest BOM check and whether it was made on the board as it is saved now. */
export async function readBomState(projectDir: string, pcbPath: string): Promise<{ state: "none" | "stale" | "current"; meta?: BomMeta; dir: string }> {
  const dir = bomDirOf(projectDir);
  const meta = JSON.parse((await readFile(join(dir, "bom-meta.json"), "utf8").catch(() => "")) || "null") as BomMeta | null;
  if (!meta) return { state: "none", dir };
  return { state: bomCurrency(meta.boardSha256, await sha256Of(pcbPath)), meta, dir };
}

export type LastFab = { designHash?: string; pcb?: string; at: string; out: string; boardSha256: string; manifestSha256: string };

export async function writeLastFab(projectDir: string, rec: LastFab): Promise<void> {
  await mkdir(releaseHome(projectDir), { recursive: true });
  await writeFile(join(releaseHome(projectDir), "last-fab.json"), JSON.stringify(rec, null, 1) + "\n");
}

export async function readLastFab(projectDir: string): Promise<LastFab | null> {
  return JSON.parse((await readFile(join(releaseHome(projectDir), "last-fab.json"), "utf8").catch(() => "")) || "null") as LastFab | null;
}

/** JLC footprint stand-ins the owner or agent recorded: `{LCSC: {proxy, why}}`. */
export async function readProxies(projectDir: string): Promise<Record<string, { proxy: string; why?: string | undefined }>> {
  const raw = JSON.parse((await readFile(join(releaseHome(projectDir), "jlc-footprint-proxies.json"), "utf8").catch(() => "")) || "{}") as Record<string, unknown>;
  return Object.fromEntries(Object.entries(raw).filter(([k, v]) => !k.startsWith("_") && v && typeof v === "object" && typeof (v as { proxy?: unknown }).proxy === "string")) as Record<string, { proxy: string; why?: string | undefined }>;
}

export async function writeProxies(projectDir: string, proxies: Record<string, { proxy: string; why?: string | undefined }>): Promise<void> {
  await mkdir(releaseHome(projectDir), { recursive: true });
  await writeFile(join(releaseHome(projectDir), "jlc-footprint-proxies.json"), JSON.stringify(proxies, null, 1) + "\n");
}
