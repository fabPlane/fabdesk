import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Settings, usageArchiveChoice } from "@fabdesk/protocol";
import { PrivacySettings } from "./PrivacySettings";

describe("PrivacySettings", () => {
  test("share usage is on by default", () => {
    const html = renderToStaticMarkup(
      <PrivacySettings draft={Settings.parse({})} update={() => {}} privacyScreen={false} />,
    );
    expect(html).toContain("On by default");
    expect(html).toContain("Turn this off to opt out");
    expect(html).toContain("Already uploaded data is not deleted.");
    expect(html).toMatch(/data-testid="settings-share-usage"[^>]*checked/);
  });

  test("saved opt-out is unchecked", () => {
    const html = renderToStaticMarkup(
      <PrivacySettings
        draft={{ ...Settings.parse({}), ...usageArchiveChoice(false) }}
        update={() => {}}
        privacyScreen={false}
      />,
    );
    expect(html).toContain('data-testid="settings-share-usage"');
    expect(html).not.toMatch(/data-testid="settings-share-usage"[^>]*checked/);
  });
});
