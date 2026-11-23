import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { planOf, type Plan } from "./engine";

/** Project rules are the baseline; explicit caller/review overrides remain visible. */
export async function projectSilkPlan(projectFile: string | null, overrides?: Partial<Plan> | null) {
  const text = projectFile ? await readFile(projectFile, "utf8") : null;
  const pro = text ? JSON.parse(text) : {};
  const settings = pro.board?.design_settings ?? {};
  const rules = settings.rules ?? {};
  const defaults = settings.defaults ?? {};
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const base: Partial<Plan> = {};
  if (finite(rules.min_text_height)) base.min_height = rules.min_text_height;
  if (finite(rules.min_text_thickness)) base.min_stroke = rules.min_text_thickness;
  if (finite(defaults.silk_text_thickness)) base.stroke = Math.max(defaults.silk_text_thickness, base.min_stroke ?? 0);
  else if (base.min_stroke !== undefined) base.stroke = base.min_stroke;
  if (finite(defaults.silk_text_size_v)) base.heights = [Math.max(defaults.silk_text_size_v, base.min_height ?? 0), ...(base.min_height ? [base.min_height] : [])];
  const plan = planOf(base);
  if (finite(rules.min_silk_clearance)) plan.clear.silk = rules.min_silk_clearance;
  const effective = planOf({ ...plan, ...overrides, clear: { ...plan.clear, ...overrides?.clear } });
  return { plan: effective, provenance: { projectFile, projectSha256: text ? createHash("sha256").update(text).digest("hex") : null, projectRules: rules, overrides: overrides ?? {}, fallbackDefaults: text === null } };
}
