import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useProjectBlobUrl } from "../hooks/queries";
import { Button, IconButton, Input, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";

// Shipped with the app, never a CDN or an unauthenticated project URL.
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export default function ProjectPdf({ projectId, path, toolbarHost }: { projectId: string; path: string; toolbarHost: HTMLElement | null }) {
  const file = useProjectBlobUrl(projectId, path);
  const [attempt, setAttempt] = useState(0);
  const retry = () => { setAttempt(value => value + 1); void file.refetch(); };
  if (file.isError || file.data === null) return <PdfUnavailable message={file.isError ? "Could not load this PDF." : "This PDF is no longer available."} busy={file.isFetching} onRetry={retry} />;
  if (!file.url || !file.data) return <div className="fd-pdf-loading" role="status"><Spinner />Loading PDF…</div>;
  return <PdfDocument key={`${file.scope}:${file.url}:${attempt}`} blob={file.data} url={file.url} path={path} onRetry={retry} toolbarHost={toolbarHost} />;
}

function PdfUnavailable({ message, busy = false, onRetry, url, path }: { message: string; busy?: boolean; onRetry: () => void; url?: string; path?: string }) {
  return <div className="fd-pdf-unavailable" role="alert"><Icon name="warning" width={30} height={30} /><h3>PDF preview unavailable</h3><p>{message}</p><p>The saved file is unchanged. You can download it and open it in another PDF reader.</p><div><Button size="sm" disabled={busy} onClick={onRetry}>Retry preview</Button>{url && <a className="fd-pdf-download" href={url} download={path?.split("/").pop()}>Download PDF</a>}</div></div>;
}

function PdfDocument({ blob, url, path, onRetry, toolbarHost }: { blob: Blob; url: string; path: string; onRetry: () => void; toolbarHost: HTMLElement | null }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null), [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1), [pageInput, setPageInput] = useState("1");
  const [zoom, setZoom] = useState<number | null>(null), [renderedScale, setRenderedScale] = useState(1);
  const [fitMode, setFitMode] = useState<"page" | "width">("page");
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const { width, height } = bounds;
  const [rendering, setRendering] = useState(true), [pageError, setPageError] = useState(false);
  const [pageText, setPageText] = useState("");
  const viewport = useRef<HTMLDivElement>(null), sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false, task: PDFDocumentLoadingTask | undefined;
    void (async () => {
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (disposed) return;
        // Render only. Do not execute document scripts, open links or fetch document resources.
        task = getDocument({ data: bytes, useWorkerFetch: false, useWasm: false, enableXfa: false });
        const document = await task.promise;
        if (!disposed) setPdf(document);
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error && failure.name === "PasswordException" ? "This PDF is password protected. Download it to open it with your password." : "This file could not be read as a PDF. It may be damaged or use an unsupported format.");
      }
    })();
    return () => { disposed = true; void task?.destroy().catch(() => {}); };
  }, [blob]);
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const measure = () => setBounds(previous => previous.width === element.clientWidth && previous.height === element.clientHeight ? previous : { width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    measure(); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { setPageInput(String(page)); }, [page]);
  useEffect(() => {
    if (!pdf || !width || !sheet.current) return;
    const target = sheet.current;
    let disposed = false, render: RenderTask | undefined, canvas: HTMLCanvasElement | undefined;
    setRendering(true); setPageError(false); setPageText("");
    void (async () => {
      try {
        const pdfPage = await pdf.getPage(page);
        if (disposed) return;
        const natural = pdfPage.getViewport({ scale: 1 });
        const scale = zoom ?? Math.max(.05, Math.min(3, (width - 32) / natural.width, fitMode === "page" ? (height - 32) / natural.height : 3));
        const view = pdfPage.getViewport({ scale });
        // Keep large engineering sheets usable without allocating an unbounded canvas.
        const pixels = Math.min(window.devicePixelRatio || 1, 2, 8192 / Math.max(view.width, view.height), Math.sqrt(12_000_000 / (view.width * view.height)));
        canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(view.width * pixels)); canvas.height = Math.max(1, Math.floor(view.height * pixels));
        canvas.style.width = `${view.width}px`; canvas.style.height = `${view.height}px`;
        canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", `${path.split("/").pop()} · Page ${page} of ${pdf.numPages}`);
        target.replaceChildren(canvas); setRenderedScale(scale);
        render = pdfPage.render({ canvas, viewport: view, transform: [pixels, 0, 0, pixels, 0, 0] });
        await render.promise;
        if (disposed) return;
        setRendering(false);
        const text = await pdfPage.getTextContent().catch(() => null);
        if (!disposed && text) setPageText(text.items.map(item => "str" in item ? item.str : "").join(" "));
      } catch {
        if (!disposed) { setRendering(false); setPageError(true); }
      }
    })();
    return () => { disposed = true; render?.cancel(); canvas?.remove(); };
  }, [pdf, page, width, height, fitMode, zoom, path]);
  const goToPage = () => {
    const requested = Number(pageInput);
    if (pdf && Number.isInteger(requested) && requested >= 1 && requested <= pdf.numPages) { setPage(requested); viewport.current?.scrollTo(0, 0); }
    else setPageInput(String(page));
  };
  const changeZoom = (delta: number) => setZoom(Math.max(.25, Math.min(3, Math.round((renderedScale + delta) * 100) / 100)));
  const toolbar = <div className="fd-pdf-toolbar" data-inline={!!toolbarHost} role="group" aria-label="PDF page and zoom controls">
      <IconButton title="Previous PDF page" size="sm" disabled={!pdf || page <= 1} onClick={() => { setPage(value => value - 1); viewport.current?.scrollTo(0, 0); }}><Icon name="chevronLeft" width={16} height={16} /></IconButton>
      <form onSubmit={event => { event.preventDefault(); goToPage(); }}><label>Page<Input aria-label="PDF page number" inputMode="numeric" value={pageInput} disabled={!pdf} onChange={event => setPageInput(event.target.value)} onBlur={goToPage} /></label><span>of {pdf?.numPages ?? "…"}</span></form>
      <IconButton title="Next PDF page" size="sm" disabled={!pdf || page >= pdf.numPages} onClick={() => { setPage(value => value + 1); viewport.current?.scrollTo(0, 0); }}><Icon name="chevronRight" width={16} height={16} /></IconButton>
      <span className="fd-pdf-toolbar-divider" />
      <IconButton title="Zoom out PDF" size="sm" disabled={!pdf || renderedScale <= .25} onClick={() => changeZoom(-.25)}><Icon name="minus" width={16} height={16} /></IconButton>
      <span className="fd-pdf-zoom">{`${Math.round(renderedScale * 100)}%`}</span>
      <IconButton title="Zoom in PDF" size="sm" disabled={!pdf || renderedScale >= 3} onClick={() => changeZoom(.25)}><Icon name="plus" width={16} height={16} /></IconButton>
      <Button size="sm" disabled={!pdf} aria-pressed={zoom === null && fitMode === "page"} onClick={() => { setFitMode("page"); setZoom(null); }}>Fit page</Button>
      <Button size="sm" disabled={!pdf} aria-pressed={zoom === null && fitMode === "width"} onClick={() => { setFitMode("width"); setZoom(null); }}>Fit width</Button>
    </div>;
  return <div className="fd-pdf-preview" aria-label="PDF reader">
    {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}
    <div ref={viewport} className="fd-pdf-viewport" aria-busy={!error && !pageError && (!pdf || rendering)}>
      {error ? <PdfUnavailable message={error} onRetry={onRetry} url={url} path={path} /> : pageError ? <PdfUnavailable message="This page could not be rendered." onRetry={onRetry} url={url} path={path} /> : <>
        {(!pdf || rendering) && <div className="fd-pdf-loading" role="status"><Spinner />{pdf ? `Rendering page ${page}…` : "Opening PDF…"}</div>}
        <div ref={sheet} className="fd-pdf-sheet" style={{ visibility: rendering ? "hidden" : "visible" }} />
        {pageText && <p className="sr-only" aria-label={`Text from PDF page ${page}`}>{pageText}</p>}
      </>}
    </div>
  </div>;
}
