/** Gate only projects that have onboarded. A waiver is the owner's explicit reason, never inferred. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openReviewProject, reviewGate, stageState } from "@fabdesk/board-workflow";
import { z } from "zod/v4";
import { ToolError } from "./registry";

export const fabricationWaiver = z.string().trim().min(1).optional().describe("Explicit user-authorized reason to export without a current settled review; recorded with this design in the manifest.");
export async function fabricationGate(dir: string, tool: string, waiver?: string, pcb?: string) {
  if (!await readFile(join(dir, ".fabdesk/board/onboard.json")).then(() => true, () => false)) return null;
  const g = await reviewGate(await openReviewProject(dir, pcb));
  const s = await stageState(dir, pcb);
  if (g.state === "pass") return null;
  if (!waiver?.trim()) throw new ToolError(`Review stage ${g.state}; independent review ${s.independent.state}: fabrication refused. Run board_review run for this design, settle its findings and current independent review (or owner's recorded deferral), then retry. Only an explicit user-authorized waiver reason bypasses this review gate.`, "precondition");
  const record = { designHash: s.designHash, tool, reason: waiver.trim(), at: new Date().toISOString() };
  const home = join(dir, ".fabdesk/board/release");
  await mkdir(home, { recursive: true });
  const file = join(home, "waivers.json");
  const records = JSON.parse(await readFile(file, "utf8").catch(() => "[]")) as unknown[];
  records.push(record);
  await writeFile(file, JSON.stringify(records, null, 2) + "\n");
  await mkdir(join(dir, "exports"), { recursive: true });
  await writeFile(join(dir, "exports/fabrication-manifest.json"), JSON.stringify({ reviewWaivers: records }, null, 2) + "\n");
  return record;
}
export async function packageWaivers(dir: string, out: string) {
  const records = JSON.parse(await readFile(join(dir, ".fabdesk/board/release/waivers.json"), "utf8").catch(() => "[]")) as unknown[];
  const file = join(out, "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as Record<string, unknown>;
  const final = records.length ? { ...manifest, reviewWaivers: records } : manifest;
  if (records.length) await writeFile(file, JSON.stringify(final, null, 2) + "\n");
  return final;
}
