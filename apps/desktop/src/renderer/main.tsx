// Sentry first so it sees errors thrown while the app boots (no-op unless main enabled reporting).
import { Sentry, sentryEnabled } from "./sentry";
import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserApp } from "@fabdesk/ui";
import { App } from "./App";

// Dev / FABDESK_AUTOMATION=1 only: window.__fabdeskApp for the core's `app` toolset (docs/app-automation.md).
if (window.fabdesk?.automationEnabled) {
  void import("./automation")
    .then((m) => m.installAutomation())
    .catch((e: unknown) => console.warn("[automation] failed to install", e));
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
// Without the Electron bridge this is the browser client: hosted pairing (`/pair`), saved
// computers, or the legacy `?core=&token=` query — BrowserApp covers all three.
const app = window.fabdesk ? <App /> : <BrowserApp />;
createRoot(root).render(
  <StrictMode>
    {sentryEnabled ? (
      <Sentry.ErrorBoundary
        fallback={
          <main className="p-6 text-sm">
            fabPlane hit an unexpected error. Please restart the app.
          </main>
        }
      >
        {app}
      </Sentry.ErrorBoundary>
    ) : (
      app
    )}
  </StrictMode>,
);
