import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivacyChoicesForm } from "./FirstInstallPrivacy";

test("analytics choice is unchecked, names the recipient/linkage, and can be declined", () => {
  const html = renderToStaticMarkup(<PrivacyChoicesForm askUsageArchive={false} pending={false} failed={false} onSave={() => {}} />);
  expect(html).toContain("PostHog");
  expect(html).toContain("account ID");
  expect(html).toContain("campaign tags");
  expect(html).toContain("Continue without analytics");
  expect(html).not.toContain('checked=""');
  expect(html).not.toContain("Share sessions and project data");
});

test("session sharing is a separate unchecked choice when requested", () => {
  const html = renderToStaticMarkup(<PrivacyChoicesForm askUsageArchive pending={false} failed={false} onSave={() => {}} />);
  expect(html.match(/type="checkbox"/g)).toHaveLength(2);
  expect(html).not.toContain('checked=""');
  expect(html).toContain("including past sessions");
  expect(html).toContain("Continue without sharing");
});
