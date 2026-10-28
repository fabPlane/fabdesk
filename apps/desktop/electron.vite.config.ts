import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Plugin } from "vite";
import { generateReleaseNotes } from "../../scripts/release-notes";
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
 * This build's "What's new" notes. Release CI generates them once and passes the file in
 * FABDESK_RELEASE_NOTES_FILE, so the app and fabplane.com show the same text; local builds
 * generate them from git here.
 */
function releaseNotes(): unknown {
  const file = process.env["FABDESK_RELEASE_NOTES_FILE"]?.trim();
  if (file) return JSON.parse(readFileSync(file, "utf8"));
  try {
    return generateReleaseNotes({ cwd: resolve(__dirname, "../..") });
  } catch {
    return null;
  }
}

/**
 * Production CSP (plan section 8). The daemon is reached over loopback only. Sentry renderer events never
 * leave the renderer directly: they reach the main process over the preload IPC, or over the SDK's
 * `sentry-ipc:` custom protocol as a fallback, so no ingest host is allowed here (docs/sentry.md).
 * Catalog thumbs load from the loopback preview proxy (`http://127.0.0.1:*`), which serves shipped
 * webps, then the images.fabplane.com CDN, then initials SVG. The renderer never fetches GitHub.
 */
const STRICT_CSP = [
  "default-src 'self'",
  "connect-src http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* sentry-ipc:",
  "img-src 'self' data: blob: http://127.0.0.1:* https:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  // Authenticated project videos are downloaded by the client and played from local blobs.
  "media-src 'self' blob:",
  // The CAD tab embeds the fab_cad web UI served by the loopback FabPlane CAD bridge. Any loopback
  // port, because the port is only known at run time: 4030 by default, but CadSupervisor moves to
  // a free port when 4030 is taken, and FABDESK_FAB_CAD_BRIDGE_URL overrides it, while this CSP is
  // fixed at build time. The frame itself is sandboxed (CadTab.tsx) and the bridge needs its token.
  "frame-src http://127.0.0.1:*",
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
  // Authenticated project videos are downloaded by the client and played from local blobs.
  "media-src 'self' blob:",
  // Any loopback port, as in STRICT_CSP: the CAD bridge's port is chosen at run time.
  "frame-src http://127.0.0.1:*",
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

/** Ship the native recognizer with the app; users never need Xcode or a CLI install. */
function nativeSpeechPlugin(): Plugin {
  return {
    name: "native-macos-speech",
    closeBundle() {
      if (process.platform !== "darwin") return;
      const output = resolve(__dirname, "out/native");
      mkdirSync(output, { recursive: true });
      execFileSync("xcrun", ["swiftc", "-O", "-module-cache-path", resolve(tmpdir(), "fabdesk-swift-cache"), "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx15.0`,
        resolve(__dirname, "native/speech.swift"),
        "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", resolve(__dirname, "native/speech-info.plist"), "-o", resolve(output, "fabdesk-speech")], { stdio: "inherit" });
    },
  };
}

export default defineConfig(({ mode }) => {
  const dev = mode === "development";
  const sentryDefine = { __FABDESK_SENTRY_RELEASE__: JSON.stringify(sentryRelease()) };
  return {
    main: {
      // Workspace packages (and their zod) are bundled into main; everything else stays external.
      plugins: [nativeSpeechPlugin(), externalizeDepsPlugin({ exclude: ["@fabdesk/updates", "@fabdesk/protocol", "zod"] })],
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
      define: {
        "process.env.IS_PREACT": JSON.stringify("false"),
        __FABDESK_RELEASE_NOTES__: JSON.stringify(releaseNotes()),
        ...sentryDefine,
      },
      build: {
        rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") },
        chunkSizeWarningLimit: 3000,
      },
    },
  };
});
