import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { CoreClient, CoreProvider, nullHost } from "@fabdesk/client-core";
import { CreateProjectDialog } from "./CreateProjectDialog";

test("new project dialog offers Start from a photo", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <CoreProvider client={new CoreClient({ baseUrl: "http://test.invalid", token: "t" })} host={nullHost} queryClient={qc}>
      <CreateProjectDialog onClose={() => {}} onCreated={() => {}} />
    </CoreProvider>,
  );
  expect(html).toContain("From a photo");
  expect(html).toContain('data-testid="start-from-photo"');
});

test("photo mode shows the drop zone", () => {
  const qc = new QueryClient();
  const html = renderToStaticMarkup(
    <CoreProvider client={new CoreClient({ baseUrl: "http://test.invalid", token: "t" })} host={nullHost} queryClient={qc}>
      <CreateProjectDialog initialMode="photo" onClose={() => {}} onCreated={() => {}} />
    </CoreProvider>,
  );
  expect(html).toContain("Start from a photo");
  expect(html).toContain('data-testid="create-project-photo-drop"');
  expect(html).toContain("Known width");
});
