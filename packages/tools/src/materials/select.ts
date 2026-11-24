import type { BoardConstructionId, BoardMaterialId } from "@fabdesk/protocol";
import { boardMaterialSummary } from "@fabdesk/protocol";
import { MATERIAL_PRESETS } from "./presets";

export type MaterialChoice = {
  id: BoardMaterialId;
  construction: BoardConstructionId;
  confidence: "high" | "medium" | "low";
  reason: string;
  source: "heuristic" | "llm";
};

type Rule = {
  id: BoardMaterialId;
  construction?: BoardConstructionId;
  confidence: "high" | "medium";
  words: RegExp;
  reason: string;
};

const RULES: Rule[] = [
  { id: "flex", confidence: "high", words: /\bflex(?:ible)?\b|\bpolyimide\b|\bwearable\b|\bprobe\b|\btail\b|\bribbon\b|\bbend\b/, reason: "The brief asks for a flexible or wearable board." },
  { id: "ptfe", construction: "2l", confidence: "high", words: /\bmmwave\b|\bmm-wave\b|\b24\s*ghz\b|\b77\s*ghz\b|\bradar\b|\bduroid\b|\bptfe\b/, reason: "Millimetre-wave / radar work wants a very low-loss PTFE laminate." },
  { id: "rogers", confidence: "high", words: /\brogers\b|\bro4350\b|\blna\b|\bpower amp(?:lifier)?\b|\b\d+(\.\d+)?\s*ghz\b|\bmicrowave\b|\blow-?loss\b/, reason: "RF / microwave language points at a controlled-Dk low-loss laminate." },
  { id: "copper_core", confidence: "high", words: /\bcopper core\b|\bpedestal\b|\bdirect[- ]heatsink\b|\bdirect copper\b/, reason: "The brief asks for a copper-core or pedestal thermal path." },
  { id: "aluminium", confidence: "high", words: /\balumin(?:i)?um\b|\bmetal[- ]core\b|\bmcpcb\b|\bled (?:panel|tile|bar|engine)\b|\bruns hot\b|\bheatsink\b/, reason: "A hot LED or metal-core board belongs on aluminium." },
  { id: "hdi", construction: "6l", confidence: "high", words: /\bhdi\b|\bmicrovia\b|\bvia-in-pad\b|\bfine[- ]pitch\b|\bbga\b|\bfpga stick\b|\b6[- ]layer\b|\b8[- ]layer\b/, reason: "Fine-pitch / microvia language needs an HDI stackup." },
];

export function selectMaterialFromBrief(
  brief: string,
  llm?: (text: string) => MaterialChoice | null,
): MaterialChoice {
  const text = brief.toLowerCase();
  for (const rule of RULES) {
    if (rule.words.test(text)) {
      const construction = rule.construction ?? MATERIAL_PRESETS[rule.id].defaultConstruction;
      return {
        id: rule.id,
        construction,
        confidence: rule.confidence,
        reason: `${rule.reason} ${boardMaterialSummary(rule.id).whenToUse}`,
        source: "heuristic",
      };
    }
  }
  const fromLlm = llm?.(brief);
  if (fromLlm) return { ...fromLlm, source: "llm" };
  return {
    id: "fr4",
    construction: "2l",
    confidence: "low",
    reason: "Nothing in the brief needs flex, metal-core, RF, or HDI, so the default is rigid FR-4.",
    source: "heuristic",
  };
}
