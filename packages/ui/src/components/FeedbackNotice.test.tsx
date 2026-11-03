import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FeedbackNotice, ConfirmationToast } from "./FeedbackNotice";

test("actionable failures announce the problem without a toast or auto-dismiss affordance", () => {
  const html = renderToStaticMarkup(<FeedbackNotice tone="error" title="Export did not finish" actions={<button>Retry export</button>}>The saved board is still available.</FeedbackNotice>);
  expect(html).toContain('role="alert"');
  expect(html).toContain("Retry export");
  expect(html).toContain("The saved board is still available.");
  expect(html).not.toContain("fd-confirmation-toast");
  expect(html).not.toContain("Dismiss");
});

test("routine confirmations announce politely and can be dismissed without stealing focus", () => {
  const html = renderToStaticMarkup(<ConfirmationToast title="Artwork saved" onDismiss={() => {}}>Circuit files are unchanged.</ConfirmationToast>);
  expect(html).toContain('role="status"');
  expect(html).toContain('aria-label="Dismiss Artwork saved"');
  expect(html).not.toContain('role="alert"');
  expect(html).not.toContain("autofocus");
});

test("persistent warnings keep their review action separate from the live announcement", () => {
  const html = renderToStaticMarkup(<FeedbackNotice tone="warning" title="Source needs review" actions={<button>Review source</button>} onDismiss={() => {}}>A saved output uses an earlier PCB.</FeedbackNotice>);
  expect(html).toContain('data-tone="warning"');
  expect(html).toContain('role="status"');
  expect(html).toContain("Review source");
  expect(html).toContain('aria-label="Dismiss Source needs review"');
  expect(html).not.toContain('role="alert"');
});
