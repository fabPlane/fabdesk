# fabdesk-key-commands

A local Expo module (autolinked from `apps/mobile/modules/`) that turns hardware-keyboard
shortcuts into JS events. React Native exposes no ⌘/Ctrl-modified key events on iOS or Android
without native code, so this is the smallest thing that does:

- **iOS**: `UIKeyCommand`s added to the window's root view controller, dispatched through a
  `UIResponder` extension so they fire whether or not a text field is focused. Commands are not
  collected while a modal sheet is presented (the presented controller is not below the root in
  the responder chain).
- **Android**: a `ReactActivityHandler.onKeyDown` hook; `cmd` matches Ctrl or Meta.

JS side: `src/layout/key-commands-native.ts` (feature-detected — the app runs without the native
build, shortcuts just do nothing) and `src/layout/keyboard.tsx` (the provider and hook).

Command ids are the canonical combo strings from `src/lib/key-combo.ts` (`cmd+n`, `shift+cmd+k`,
`cmd+enter`); both native sides parse them and echo the same string back.

Needs `bunx expo prebuild` and a native rebuild after adding or changing.
