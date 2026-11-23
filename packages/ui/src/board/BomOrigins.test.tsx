import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { CoreClient, CoreProvider, nullHost } from "@fabdesk/client-core";
import { ProjectBoardSources, type BomSourceCoverage, type ProjectBomSnapshot } from "@fabdesk/protocol";
import { BomOrigins } from "./BomOrigins";

const source: BomSourceCoverage = { sourceId: null, name: "Main board", directory: ".", instanceIds: [], multiplier: 1, componentCount: 6, status: "native-schematic" };
const snapshot: ProjectBomSnapshot = { contract: "fabplane.project-bom.v1", projectId: "p", manifestSha256: null, revision: "r", capturedAt: "2026-11-16T00:00:00Z", complete: true, coverage: [source], lines: [], inputs: [], absentInputs: [], notes: [] };
const single = ProjectBoardSources.parse({ projectId: "p", mode: "single", manifestSha256: null, editing: "single-board-only", observedAt: snapshot.capturedAt, assembly: null, sources: [] });

function render(options: { hardwareState?: "loading" | "ok" | "error"; refreshFailed?: boolean; snapshot?: ProjectBomSnapshot; sources?: ProjectBoardSources } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  qc.setQueryData(["board-sources", "p"], options.sources ?? single);
  try {
    return renderToStaticMarkup(<CoreProvider client={new CoreClient({ baseUrl: "http://test.invalid", token: "test" })} host={nullHost} queryClient={qc}>
      <BomOrigins snapshot={options.snapshot ?? snapshot} hardwareState={options.hardwareState ?? "ok"} refreshFailed={options.refreshFailed ?? false} open onOpenChange={() => {}} />
    </CoreProvider>);
  } finally { qc.clear(); }
}

test("loading hardware is not an unreadable-hardware error or proof that none was added", () => {
  const loading = render({ hardwareState: "loading" });
  expect(loading).toContain("Reading project hardware…");
  expect(loading).not.toContain("Hardware unreadable");
  expect(loading).not.toContain("None added");
  const failed = render({ hardwareState: "error" });
  expect(failed).toContain("Hardware unreadable");
  expect(failed).toContain("Could not read project hardware");
});

test("a failed refresh labels cached coverage in the collapsed summary and keeps the recovery direction", () => {
  const html = render({ refreshFailed: true });
  expect(html.slice(0, html.indexOf("</summary>"))).toContain("Last read · Refresh failed");
  expect(html).toContain("Showing the last successful read");
  expect(html).toContain("Use Refresh parts to try again");
  expect(render()).not.toContain("Refresh failed");
});

test("excluded boards are not presented as included or requiring source recovery", () => {
  for (const status of ["native-schematic", "saved-netlist", "unused"] as const) {
    const html = render({ snapshot: { ...snapshot, coverage: [{ ...source, multiplier: 0, status }] } });
    expect(html).toContain("Not counted");
    expect(html).not.toContain("Schematic read");
    expect(html).not.toContain("Review source");
    expect(html).not.toContain("Open schematic");
  }
});

test("schematic navigation requires the matching project and a selectable owned board instance", () => {
  const openButton = (html: string) => html.match(/<button[^>]*title="(?:Open this board|Current board ownership)[^"]*"[^>]*>/)?.[0];
  expect(openButton(render())).not.toContain('disabled=""');
  expect(openButton(render({ sources: { ...single, projectId: "another-project" } }))).toContain('disabled=""');
  const declaration = { id: "io", name: "I/O", location: "project", directory: "boards/io" };
  const other = { ...declaration, id: "other", directory: "boards/other" };
  const assembly = ProjectBoardSources.parse({ ...single, mode: "assembly", manifestSha256: "a".repeat(64), assembly: { contract: "fabplane.assembly.v1", sources: [declaration, other], instances: [{ id: "other-board", name: "Other board", sourceId: "other" }], connections: [] }, sources: [{ source: declaration, status: "available", pcbPath: "boards/io/board.kicad_pcb" }, { source: other, status: "missing" }] });
  const captured = { ...snapshot, manifestSha256: assembly.manifestSha256, coverage: [{ ...source, sourceId: "io" }] };
  expect(openButton(render({ snapshot: captured, sources: assembly }))).toContain('disabled=""');
});
