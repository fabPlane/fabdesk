import { CoreClient, CoreProvider, PreviewInTrashError } from "@fabdesk/client-core";
import { QueryClient } from "@tanstack/react-query";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardPreview } from "./BoardPreview";

test("a trashed 3D model leaves the saved PCB drawing interactive; 3D offers recovery", async () => {
  const client = new CoreClient({ baseUrl: "http://test" });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const scope = ["p", client.baseUrl, ".", "root", ""];
  const path = "board.kicad_pcb";
  const stamp = JSON.stringify([[path, 20, 1]]);
  const revision = JSON.stringify(["pcb-hash", "model-inputs"]);
  const render = (mode: "pcb" | "3d") => renderToStaticMarkup(
    <CoreProvider client={client} queryClient={queries}>
      <BoardPreview projectId="p" mode={mode} sourceStamp="1:20" />
    </CoreProvider>
  );
  try {
    queries.setQueryData(["project", "p"], { files: [{ path, size: 20, mtime: 1 }] });
    queries.setQueryData(["board-sources", "p"], { mode: "single", sources: [] });
    queries.setQueryData(["preview-inputs", ...scope, stamp], { hashes: { [path]: "pcb-hash" }, dependencies: "model-inputs" });
    queries.setQueryData(["live-preview", ...scope, "pcb", revision], { svg: '<svg viewBox="0 0 10 10"></svg>' });
    await queries.prefetchQuery({ queryKey: ["live-preview", ...scope, "model", revision], queryFn: () => { throw new PreviewInTrashError("3D model is in Trash."); } });
    const pcb = render("pcb");
    expect(pcb).toContain("Fit board");
    expect(pcb).toContain("Open outputs");
    expect(pcb).not.toContain('class="fd-preview-loading"');
    const model = render("3d");
    expect(model).toContain('class="fd-preview-loading"');
    expect(model).toContain("Open outputs");
  } finally {
    queries.clear();
  }
});
