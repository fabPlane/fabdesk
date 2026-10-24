import type { FileKind } from "./file-explorer";

/** Shapes as well as color distinguish formats, including in monochrome themes. */
export function FileGlyph({ kind, className = "" }: { kind: FileKind; className?: string }) {
  const shapes = {
    board: <><rect x="5" y="5" width="14" height="14" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3" /></>,
    schematic: <><path d="M3 12h5m8 0h5M8 8h8v8H8zM12 3v5m0 8v5" /></>,
    code: <><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18" /></>,
    text: <><path d="M14 3H5v18h14V8l-5-5v5h5M8 12h8m-8 4h6" /></>,
    data: <><path d="M8 4H6v6l-2 2 2 2v6h2m8-16h2v6l2 2-2 2v6h-2" /><circle cx="12" cy="9" r=".7" /><circle cx="12" cy="15" r=".7" /></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8" cy="8" r="2" /><path d="m3 17 6-5 4 3 4-6 4 5" /></>,
    video: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m10 9 5 3-5 3z" /></>,
    drawing: <><path d="m4 20 7-17 9 17H4Z" /><path d="m8 13 8 0M11 3v17" /></>,
    model: <><path d="m12 2 9 5v10l-9 5-9-5V7l9-5Zm0 10 9-5M12 12 3 7m9 5v10" /></>,
    archive: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M10 3v3h4v3h-4v3h4v3h-4v3h4" /></>,
    file: <path d="M14 3H5v18h14V8l-5-5v5h5" />,
  };
  return <svg className={`fd-file-glyph fd-file-${kind} shrink-0 ${className}`} width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[kind]}</svg>;
}
