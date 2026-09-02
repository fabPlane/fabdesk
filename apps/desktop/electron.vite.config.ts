import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/** Production CSP (plan section 8). The daemon is reached over loopback only. */
const STRICT_CSP = [
  "default-src 'self'",
  "connect-src http://127.0.0.1:* ws://127.0.0.1:* http://localhost:*",
  "img-src 'self' data: blob: http://127.0.0.1:*",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
].join("; ");

/** Dev needs Vite's HMR websocket and the React refresh inline preamble. */
const DEV_CSP = [
  "default-src 'self' http://localhost:*",
  "script-src 'self' 'unsafe-inline' http://localhost:*",
  "connect-src http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*",
  "img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*",
  "style-src 'self' 'unsafe-inline' http://localhost:*",
  "font-src 'self' data: http://localhost:*",
  "worker-src 'self' blob:",
].join("; ");

function cspPlugin(dev: boolean): Plugin {
  return {
    name: "fabdesk:csp",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: dev ? DEV_CSP : STRICT_CSP },
          injectTo: "head-prepend",
        },
      ];
    },
  };
}

export default defineConfig(({ mode }) => {
  const dev = mode === "development";
  return {
    main: {
      // Workspace packages (and their zod) are bundled into main; everything else stays external.
      plugins: [externalizeDepsPlugin({ exclude: ["@fabdesk/updates", "@fabdesk/protocol", "zod"] })],
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
      plugins: [react(), tailwindcss(), cspPlugin(dev)],
      define: { "process.env.IS_PREACT": JSON.stringify("false") },
      build: {
        rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") },
        chunkSizeWarningLimit: 3000,
      },
    },
  };
});
