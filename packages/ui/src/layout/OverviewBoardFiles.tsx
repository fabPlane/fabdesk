import { Button } from "../components/ui";
import { Icon } from "../components/Icon";

/** File discovery does not imply declared assembly membership or a canonical editable board. */
export function OverviewBoardFiles({ paths, onOpen, onEnclosure }: {
  paths: string[];
  onOpen: (path: string) => void;
  onEnclosure: () => void;
}) {
  return <section className="fd-overview-source-boards" aria-label="Saved board files">
    <div className="fd-overview-source-heading"><h2>Boards</h2><Button size="sm" onClick={onEnclosure}><Icon name="cube" width={16} height={16} />Open enclosure</Button></div>
    <div className="fd-overview-source-grid">{paths.map(path => {
      const name = path.split(/[\\/]/).pop()!.replace(/\.kicad_pcb$/i, "");
      return <button key={path} className="fd-overview-source-card" onClick={() => onOpen(path)} aria-label={`Open board file: ${path}`}>
        <Icon name="pcb" width={24} height={24} />
        <span><strong>{name}</strong><small>{path}</small><span className="fd-overview-source-action">View source file <span aria-hidden="true">→</span></span></span>
      </button>;
    })}</div>
  </section>;
}
