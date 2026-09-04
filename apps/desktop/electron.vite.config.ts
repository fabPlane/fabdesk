import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { themeBootInlineCss, themeBootInlineScript } from "../../packages/ui/src/theme/boot-inline";

/** Short git sha for the Sentry release: CI has GITHUB_SHA, local builds ask git, else `dev`. */
function gitSha(): string {
  const ci = process.env["GITHUB_SHA"]?.trim();
  if (ci) return ci.slice(0, 7);
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "dev";
  } catch {
    return "dev";
  }
}

/** `fabdesk@<version>+<sha>` unless VITE_SENTRY_RELEASE / SENTRY_RELEASE is set at build time (docs/sentry.md). */
function sentryRelease(): string {
  const explicit = process.env["VITE_SENTRY_RELEASE"]?.trim() || process.env["SENTRY_RELEASE"]?.trim();
  if (explicit) return explicit;
  const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")) as { version: string };
  return `fabdesk@${pkg.version}+${gitSha()}`;
}

/**
 * Production CSP (plan section 8). The daemon is reached over loopback only. Sentry renderer events never
 * leave the renderer directly: they reach the main process over the preload IPC, or over the SDK's
 * `sentry-ipc:` custom protocol as a fallback, so no ingest host is allowed here (docs/sentry.md).
 * `img-src https:` is required for the open-source catalog: seed/API preview and hero images are
 * GitHub OpenGraph / raw.githubusercontent.com / R2 URLs, not loopback.
 */
const STRICT_CSP = [
  "default-src 'self'",
  "connect-src http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* sentry-ipc:",
  "img-src 'self' data: blob: http://127.0.0.1:* https:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
];

/** Dev needs Vite's HMR websocket and the React refresh inline preamble. */
const DEV_CSP = [
  "default-src 'self' http://localhost:*",
  "script-src 'self' 'unsafe-inline' http://localhost:*",
  "connect-src http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* sentry-ipc:",
  "img-src 'self' data: blob: http://127.0.0.1:* http://localhost:* https:",
  "style-src 'self' 'unsafe-inline' http://localhost:*",
  "font-src 'self' data: http://localhost:*",
  "worker-src 'self' blob:",
].join("; ");

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64");
}

function cspPlugin(dev: boolean): Plugin {
  const script = themeBootInlineScript();
  const css = themeBootInlineCss();
  const productionCsp = [...STRICT_CSP, `script-src 'self' 'sha256-${sha256(script)}'`].join("; ");
  return {
    name: "fabdesk:theme-boot",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: dev ? DEV_CSP : productionCsp },
          injectTo: "head-prepend",
        },
        { tag: "style", children: css, injectTo: "head-prepend" },
        { tag: "script", children: script, injectTo: "head-prepend" },
      ];
    },
  };
}

export default defineConfig(({ mode }) => {
  const dev = mode === "development";
  const sentryDefine = { __FABDESK_SENTRY_RELEASE__: JSON.stringify(sentryRelease()) };
  return {
    main: {
      // Workspace packages (and their zod) are bundled into main; everything else stays external.
      plugins: [externalizeDepsPlugin({ exclude: ["@fabdesk/updates", "@fabdesk/protocol", "zod"] })],
      define: sentryDefine,
      build: {
        rollupOptions: { input: resolve(__dirname, "src/main/index.ts") },
      },
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      build: {
        // Sandboxed preload scripts must be CommonJS.
        rollupOptions: {
          input: resolve(__dirname, "src/preload/index.ts"),
          output: { format: "cjs", entryFileNames: "[name].cjs" },
        },
      },
    },
    renderer: {
      resolve: {
        alias: [
          { find: /^@fabdesk\/ui$/, replacement: resolve(__dirname, "../../packages/ui/src/index.ts") },
          { find: "@fabdesk/ui/styles.css", replacement: resolve(__dirname, "../../packages/ui/src/styles.css") },
        ],
      },
      plugins: [react(), tailwindcss(), cspPlugin(dev)],
      define: { "process.env.IS_PREACT": JSON.stringify("false"), ...sentryDefine },
      build: {
        rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") },
        chunkSizeWarningLimit: 3000,
      },
    },
  };
});
