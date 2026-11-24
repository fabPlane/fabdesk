import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CoreClient, CoreProvider, useCoreClient } from "@fabdesk/client-core";
import { NativeBoardScope } from "./NativeBoardScope";
import { NativePreviewStatus } from "./NativePreviewStatus";

function DangerousChild() {
  const client = useCoreClient();
  return <span>{client.nativeSource?.sourcePath ?? "ROOT MUTATION"}</span>;
}
function render(pending: boolean, error: string | null, sourcePath: string | null = "hardware/io-v3.kicad_pcb") {
  return renderToStaticMarkup(<CoreProvider client={new CoreClient({ baseUrl: "http://test.invalid", token: "test" })}>
    <NativeBoardScope projectId="one" threadId="chat" design={{ sourcePath }} enabled pending={pending} error={error} onRetry={() => {}}><DangerousChild /></NativeBoardScope>
  </CoreProvider>);
}
test("cold and failed source queries never mount root actions, even with cached selected data", () => {
  for (const path of [null, "hardware/io-v3.kicad_pcb"]) {
    const pending = render(true, null, path);
    expect(pending).toContain("Loading working source");
    expect(pending).not.toContain("ROOT MUTATION");
    const failed = render(false, "Source service unavailable", path);
    expect(failed).toContain("Source service unavailable");
    expect(failed).toContain("Retry source");
    expect(failed).not.toContain("ROOT MUTATION");
  }
  expect(render(false, null)).toContain("hardware/io-v3.kicad_pcb");
});
test("automatic preview errors disclose older content and same-revision retry", () => {
  const html = renderToStaticMarkup(<NativePreviewStatus source="hardware/io-v3.kicad_pcb" pending={false} error="Preview renderer is busy" onRetry={() => {}} />);
  expect(html).toContain("Automatic preview failed");
  expect(html).toContain("Preview renderer is busy");
  expect(html).toContain("older than the saved source");
  expect(html).toContain("Retry preview");
  expect(renderToStaticMarkup(<NativePreviewStatus source="io" pending={false} error={null} onRetry={() => {}} />)).toBe("");
});

test("native identity exposes board basename, revision folder and saved source hash", async () => {
  const { ImportedBoardIdentity } = await import("./ImportedBoardIdentity");
  for (const path of ["work/io/candidate/board.kicad_pcb", "work/carrier/rev-v7/board.kicad_pcb", "hardware/alpha_v3.kicad_pcb"]) {
    const html = renderToStaticMarkup(<CoreProvider client={new CoreClient({ baseUrl: "http://test.invalid", token: "test" })}>
      <ImportedBoardIdentity projectId="one" workingSource={path} sourceRevision={"a".repeat(64)} />
    </CoreProvider>);
    expect(html).toContain(path);
    expect(html).toContain(path.split("/").pop()!);
    expect(html).toContain(path.split("/").slice(-3, -1).join("/"));
    expect(html).toContain("Saved source revision: aaaaaaaaaaaa");
  }
});
