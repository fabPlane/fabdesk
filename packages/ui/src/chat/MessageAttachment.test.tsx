import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageAttachment } from "./MessageAttachment";

for (const path of ["/selected/design.kicad_sch", "/selected/board.kicad_pcb", "C:\\selected\\board.kicad_pro", "notes/requirements.pdf"]) {
  test(`native or document attachment stays a file without an image fetch: ${path}`, () => {
    // No Core/query provider: a file card must not attempt the authenticated image pipeline.
    const html = renderToStaticMarkup(<MessageAttachment path={path} mime={path.endsWith(".pdf") ? "application/pdf" : "text/plain"} />);
    expect(html).toContain(path.split(/[\\/]/).at(-1)!);
    expect(html).toContain("File attached to this request.");
    expect(html).toContain("<details");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("Image file unavailable");
  });
}
