import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@fabdesk/client-core", () => ({
  usePatchSettings: () => ({
    mutate: mock(() => {}),
    isPending: false,
    isError: false,
  }),
}));

const { FirstInstallPrivacy } = await import("./FirstInstallPrivacy");

describe("FirstInstallPrivacy", () => {
  test("checkbox starts checked and lists what is uploaded", () => {
    const html = renderToStaticMarkup(<FirstInstallPrivacy />);
    expect(html).toContain("Usage data is on unless you opt out");
    expect(html).toContain("Conversations, including past ones");
    expect(html).toContain("Agent and tool activity");
    expect(html).toContain("Prompts and project files");
    expect(html).toContain("Share usage data (uncheck to opt out)");
    expect(html).toMatch(/type="checkbox"[^>]*checked/);
  });
});
