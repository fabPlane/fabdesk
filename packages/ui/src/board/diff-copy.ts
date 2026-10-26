export type DiffHeadlineSummary = {
  added: number;
  removed: number;
  moved: number;
  changed: number;
  netsAdded: number;
  netsRemoved: number;
  netsChanged: number;
};

export function diffHeadline(report: { summary?: DiffHeadlineSummary } | null): string {
  if (!report?.summary) return "Compare two git revisions of this board.";
  const s = report.summary;
  return `+${s.added} / −${s.removed} / ~${s.changed} parts · ${s.moved} moved · nets +${s.netsAdded}/−${s.netsRemoved}/~${s.netsChanged}`;
}
