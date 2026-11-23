# Build resources

- `icon.icns`: native macOS application icon, including the platform-specific size variants.
- `icon.ico`: native Windows application icon, including the platform-specific size variants.
- `icons/`: Linux PNG application icons from 16x16 through 512x512.
- `icon.png`: 1024x1024 source artwork and fallback icon.
- `dev/`: the same icon with a "DEV" band, shown only by unpackaged (`bun run dev`) runs. Generated from
  `icon.png` by `bun run desktop:dev-icons`; rerun it when the artwork changes. Not packaged.
  `FABDESK_DEV_ICON=0 bun run dev` shows the plain icon instead (screen recordings).
- `entitlements.mac.plist`: hardened-runtime entitlements (allow-jit etc.) applied to the app and the
  signed `fabdesk-core` sidecar.
