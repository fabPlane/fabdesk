# Build resources

- `icon.png` (1024x1024) is a generated "FP" placeholder; `bun run icons` (scripts/make-icon.ts) regenerates it.
  electron-builder derives `.icns` / `.ico` from it. Replace with the real artwork before a public release.
- `entitlements.mac.plist`: hardened-runtime entitlements (allow-jit etc.) applied to the app and the
  signed `fabdesk-core` sidecar.
