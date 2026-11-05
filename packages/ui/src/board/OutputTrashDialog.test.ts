import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OutputTrashReviewList } from "./OutputTrashDialog";

test("removal review shows exact formats and concrete protection reasons without including dependencies", () => {
  const html = renderToStaticMarkup(createElement(OutputTrashReviewList, { files: [
    { path: "exports/product-video.mp4", eligible: true, reason: "Only this file is moved.", size: 1024 },
    { path: "renders/board.glb", eligible: false, reason: "Saved input used by exports/product-video.json." },
  ], selected: ["exports/product-video.mp4", "renders/board.glb"], onSelect: () => {} }));
  expect(html).toContain("exports/product-video.mp4"); expect(html).toContain("Saved input used by exports/product-video.json.");
  expect(html.match(/checked=""/g)).toHaveLength(1); expect(html.match(/disabled=""/g)).toHaveLength(1);
  expect(html).not.toContain("product-video.gif"); expect(html).not.toContain("board.kicad_pcb");
});
