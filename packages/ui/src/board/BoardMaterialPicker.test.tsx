import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardMaterialBadge, BoardMaterialPicker } from "./BoardMaterialPicker";

test("material picker lists every preset with when-to-use copy", () => {
  const html = renderToStaticMarkup(
    <BoardMaterialPicker value={{ material: "fr4", construction: "2l" }} onChange={() => {}} />,
  );
  expect(html).toContain('data-testid="board-material-picker"');
  expect(html).toContain("FR-4");
  expect(html).toContain("Flex");
  expect(html).toContain("Aluminium");
  expect(html).toContain("Copper core");
  expect(html).toContain("Rogers");
  expect(html).toContain("PTFE");
  expect(html).toContain("HDI");
  expect(html).toContain("Everyday digital");
  expect(html).toContain("Specialist fab");
});

test("construction options follow the selected material", () => {
  const html = renderToStaticMarkup(
    <BoardMaterialPicker value={{ material: "rogers", construction: "hybrid" }} onChange={() => {}} />,
  );
  expect(html).toContain('data-testid="board-construction"');
  expect(html).toContain("hybrid");
  expect(html).toContain("2l");
});

test("badge names the laminate", () => {
  const html = renderToStaticMarkup(<BoardMaterialBadge material="ptfe" construction="2l" />);
  expect(html).toContain('data-testid="board-material-badge"');
  expect(html).toContain("PTFE");
  expect(html).toContain("2l");
});
