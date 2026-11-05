import { DisclosureSummary } from "../components/DisclosureSummary";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../components/Icon";

export function ReviewScope({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<Element | null>(null);
  useLayoutEffect(() => { setHost(document.querySelector("[data-review-scope-slot]")); }, []);
  const field = <label className="fd-review-scope"><span>Scope:</span>{children}</label>;
  return host ? createPortal(field, host) : <div className="fd-review-inline-scope">{field}</div>;
}

export function ReviewDesignSources({ pcb, schematic, status, note, action, children }: {
  pcb: string; schematic: string; status: string; note: string; action: ReactNode; children?: ReactNode;
}) {
  return <section className="fd-review-design-card" aria-label="Design sources">
    <h3>Design sources</h3>
    <div className="fd-review-design-body">
      <div className="fd-review-design-file"><Icon name="pcb" width={28} height={28} /><div><strong>PCB</strong><small>{pcb}</small></div></div>
      <div className="fd-review-design-file"><Icon name="compose" width={28} height={28} /><div><strong>Schematic</strong><small>{schematic}</small></div></div>
      <div className="fd-review-design-relationship"><strong><i />{status}</strong><p>{note}</p></div>
      <div className="fd-review-design-action">{action}</div>
    </div>
    {children}
  </section>;
}

export type ReviewOutputRow = {
  key: string; item: string; icon: IconName; status: string; warning?: boolean; note?: string;
  details?: ReactNode; actions: ReactNode;
};
export function ReviewUpdateTable({ title, rows, collapsed = false, summaryStatus, summaryWarning = false }: { title: string; rows: ReviewOutputRow[]; collapsed?: boolean; summaryStatus?: string; summaryWarning?: boolean }) {
  const content = <section className="fd-review-update-group fd-review-output-group" aria-label={title}><h3>{title}</h3>
    <div className="fd-review-table-frame"><table className="fd-review-output-table" aria-label={`${title} source review`}>
      <thead><tr><th>Item</th><th>Status</th><th>Update</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.key} data-review-item={row.key}>
        <td><div className="fd-review-item-name"><Icon name={row.icon} width={28} height={28} /><strong>{row.item}</strong></div></td>
        <td><div className="fd-review-item-status" data-warning={row.warning === true}><i /><div><strong>{row.status}</strong>{row.note && <p>{row.note}</p>}{row.details && <details className="fd-review-source-details"><DisclosureSummary icon="folderOpen" label="Source details" variant="compact" />{row.details}</details>}</div></div></td>
        <td><div className="fd-review-item-actions">{row.actions}</div></td>
      </tr>)}</tbody>
    </table></div>
  </section>;
  return collapsed ? <details className="fd-review-checks-summary"><DisclosureSummary icon="shield" label={title} badge={summaryStatus} warning={summaryWarning} />{content}</details> : content;
}

export function ReviewKeepNote() {
  return <p className="fd-review-keep-note"><Icon name="shield" width={17} height={17} />Keeping a saved file does not mark the design as checked.</p>;
}
