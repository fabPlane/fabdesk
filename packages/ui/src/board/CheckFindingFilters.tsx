import { useRef } from "react";
import type { Violation } from "@fabdesk/client-core";
import { Select, Button, Input } from "../components/ui";

export function CheckFindingFilters({ rows, count, query, severity, onChange }: { rows: readonly Violation[]; count: number; query: string; severity: string; onChange: (query: string, severity: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const severities = [...new Set(rows.map(row => row.severity.toLowerCase()))].filter(Boolean).sort();
  const errors = rows.filter(row => row.severity.toLowerCase() === "error").length;
  const warnings = rows.filter(row => row.severity.toLowerCase() === "warning").length;
  return <div className="fd-finding-filters">
    <Input ref={input} aria-label="Find saved check findings" placeholder="Rule, component or description…" value={query} onChange={event => onChange(event.target.value, severity)} />
    <label>Severity<Select aria-label="Filter findings by severity" value={severity} onChange={event => onChange(query, event.target.value)}><option value="all">All severities</option>{severities.map(value => <option key={value} value={value}>{value === "error" ? "Errors" : value === "warning" ? "Warnings" : value} · {rows.filter(row => row.severity.toLowerCase() === value).length}</option>)}</Select></label>
    <span role="status">{count} of {rows.length} saved findings · {errors} {errors === 1 ? "error" : "errors"} · {warnings} {warnings === 1 ? "warning" : "warnings"}<small className="block text-muted">Errors first · Select a finding for details</small></span>
    {(query || severity !== "all") && <Button size="sm" variant="ghost" aria-label="Clear finding filters" onClick={() => { input.current?.focus(); onChange("", "all"); }}>Clear filters</Button>}
  </div>;
}
