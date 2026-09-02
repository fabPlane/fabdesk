// Sentry first so it sees errors thrown while the app boots (no-op unless main enabled reporting).
import { Sentry, sentryEnabled } from "./sentry";
import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
const app = <App />;
createRoot(root).render(
  <StrictMode>
    {sentryEnabled ? (
      <Sentry.ErrorBoundary
        fallback={
          <main className="p-6 text-sm">
            Fabdesk hit an unexpected error. Please restart the app.
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
