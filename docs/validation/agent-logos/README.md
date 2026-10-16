# Provider logos

Capture source: 46d1b8ff272b312f3b900416f3a995b31774a9cc.

The composer shows the provider logo and model name, replacing the provider name and separator. The menu shows logos for all supported providers: Codex, Claude, Grok, and Cursor. Provider names remain in accessible labels and tooltips. Marks are bundled locally from [Lobe Icons](https://github.com/lobehub/lobe-icons); pinned source and MIT license are beside the component. No runtime download or dependency was added.

Verified with actual UI components and mock API data in Windows Edge Chromium at 1440 x 920 and 960 x 600: four menu logos, switching every provider, 18 px sizing, accessible provider labels, Escape focus return, and no horizontal document overflow. UI typecheck, UI tests, and desktop build passed. Physical Mac was not rerun.

![Agent picker, wide](picker-1440.png)
![Agent picker, minimum window](picker-960.png)

Follow-up: Codex uses an outlined adaptation of the mark. Provider rows use consistent logo/name/status/chevron columns; the selection dot stays beside the name. Three not-installed labels were checked for identical horizontal alignment at both sizes, including switching to an uninstalled agent. UI typecheck and desktop build passed.
