/** The edit's verdict: A1-A9 after the edit against the project before it. Strict when the project passed; no new failure when it already failed. */
import { UNROUTED_OPENS } from "../lastmile/repair";
import type { CheckKey, AcceptanceResults } from "../accept";

export interface Judgement {
  mode: "strict" | "no-regression";
  verdict: string;
  pass: boolean;
  /** Checks that fail now and passed before (no-regression), or every failing check (strict). */
  failing: string[];
  figures: { open: number | null; drc: Record<string, number>; a7: number | null; a8: number | null };
}

interface Judged {
  summary: Record<CheckKey, boolean>;
  results: AcceptanceResults;
}

const pyList = (l: string[]) => `[${l.map((s) => `'${s}'`).join(", ")}]`;
const cnt = (r: Judged, k: CheckKey, f: string): unknown => (r.results[k] as Record<string, unknown> | undefined)?.[f];
const drcN = (r: Judged) => Object.values((cnt(r, "A2_drc", "errors") as Record<string, number> | undefined) ?? {}).reduce((a, b) => a + b, 0);

export function judge(before: Judged, after: Judged): Judgement {
  const summ = after.summary;
  const figures = {
    open: (cnt(after, "A1_connectivity", "unconnected") as number | undefined) ?? null,
    drc: (cnt(after, "A2_drc", "errors") as Record<string, number> | undefined) ?? {},
    a7: (cnt(after, "A7_widths", "nets_failing") as number | undefined) ?? null,
    a8: (cnt(after, "A8_pairs", "nets_failing") as number | undefined) ?? null,
  };
  const failingNow = (Object.entries(summ) as Array<[CheckKey, boolean]>).filter(([, v]) => !v).map(([k]) => k);
  const bothPass = Object.values(before.summary).every(Boolean);
  if (bothPass) {
    return {
      mode: "strict",
      verdict: failingNow.length ? "FAIL " + failingNow.join(",") : "PASS all A1-A9 with parity",
      pass: !failingNow.length,
      failing: failingNow,
      figures,
    };
  }
  // counts, not absolutes: a reference board may carry its own DRC errors or parity deviations
  let worse: string[] = failingNow.filter((k) => before.summary[k]);
  const a8b = (cnt(before, "A8_pairs", "nets_failing") as number | undefined) ?? 0;
  const a8a = (cnt(after, "A8_pairs", "nets_failing") as number | undefined) ?? 0;
  if (!summ.A8_pairs && !before.summary.A8_pairs && a8a > a8b) worse.push(`A8 ${a8b}->${a8a}`);
  if (drcN(after) > drcN(before)) worse.push(`A2 errors ${drcN(before)}->${drcN(after)}`);
  const p0 = (cnt(before, "A3_parity", "items") as number | undefined) ?? 0;
  const p1 = (cnt(after, "A3_parity", "items") as number | undefined) ?? 0;
  if (p1 > p0) worse.push(`A3 items ${p0}->${p1}`);
  worse = worse.filter((w) => w !== "A2_drc" && w !== "A3_parity");
  // A1: a project that was connected must stay connected (failingNow names it); one that was not routed yet (a placed,
  // unrouted board on its way to layout: the plan names A1 in accept_before) must not gain any. Requiring A1 to pass
  // outright made every ECO on such a board "FAIL regress []" (an s7-whole run: 208 opens before and after).
  const o0 = (cnt(before, "A1_connectivity", "unconnected") as number | undefined) ?? 0;
  const o1 = (cnt(after, "A1_connectivity", "unconnected") as number | undefined) ?? 0;
  // (the same line as the edit's repair skip, UNROUTED_OPENS: a routed board with a few opens left still has to end connected)
  const unrouted = !before.summary.A1_connectivity && o0 >= UNROUTED_OPENS;
  if (unrouted && !summ.A1_connectivity && o1 > o0) worse.push(`A1 opens ${o0}->${o1}`);
  const ok = !worse.length && (summ.A1_connectivity || unrouted);
  return { mode: "no-regression", verdict: ok ? "PASS (no regression)" : `FAIL regress ${pyList(worse)}`, pass: ok, failing: ok ? [] : worse.length ? worse : failingNow, figures };
}
