# Shopping list, questions, and feedback

Capture source: `e87a703de8dc7716283d54421832de071cf56894`.

Screenshots show actual React components in the Windows Electron app with isolated sample data and fake API callbacks. The app's capture bridge captured only the fixture panels, excluding personal chat history. No real shopping data was changed and no agent run was started.

- `shopping-list.png` (960 × 1010): supplier cards, theme-colored headings, labeled actions, search, order filters, progress, and inline status controls.
- `question-card.png` (720 × 527): multiple choices and a custom answer awaiting explicit submission.
- `error-recovery.png` (720 × 390): expired-login and missing-linked-item recovery guidance, with technical details available.

Validation at the capture source: 279 UI/client tests and 65 focused core/agent tests passed. UI, client-core, agents, and core typechecks and the desktop build passed. Three Windows fixture tests failed: two require symbolic-link privileges, and one uses a Unix-style launcher.

Live shopping checks covered draft retention through collapse/filter changes, failed-save recovery, conflict handling, quick status changes, repeated additions, removal confirmation, links, and BOM sync with fake callbacks. The 320px layout had no horizontal overflow. Opening/closing and filter-entry animations were observed in the running app; supplier headings remained non-sticky. Reduced-motion rules disable the added motion. Test fixtures were removed after capture.
