# Third-party components and notices

The project's root license covers original fabDesk contributions only. Separately
licensed components, submodules, fixtures and artwork retain their own terms.
This index does not replace their license texts or grant rights to trademarks.

| Component | Source / notice |
| --- | --- |
| Electron and bundled Chromium/Node | https://github.com/electron/electron; retain the Electron and Chromium license files emitted by packaging. |
| FabPlane KiCad fork | https://github.com/TensorFleet/kicad; bundled notices are staged from `third-party/kicad/<source revision>/`. |
| KiCad placement library data | `packages/client-core/src/placement/LIBRARY-LICENSE.md`: CC-BY-SA-4.0 with the KiCad design-output exception. Retain the notice when redistributing library collections. |
| KiCad test fixtures | `packages/client-core/src/placement/fixtures/KICAD-LICENSE.md` and notices beside the corresponding fixtures. |
| Agent logos | `packages/ui/src/components/agent-logos.LICENSE`: MIT, LobeHub attribution and exact upstream revision. Brand marks remain their owners' trademarks. |
| FabPlane PCB bridge/client | Public pinned source at https://github.com/fabPlane/fab_pcb; preserve nested third-party and fixture notices. |
| FabPlane CAD bridge/client | Public pinned source at https://github.com/fabPlane/fab_cad; preserve nested example and icon notices. |
| API client | https://github.com/fabPlane/fabplane-cli, MIT. |
| FreeCAD optional engine | https://github.com/fabPlane/FreeCAD; runtime staging requires `licenses/NOTICE.txt` and corresponding `sources/FreeCAD.tar.gz`. |
| Freerouting and OpenJDK | `vendor/fab_pcb/packages/kicad-patches/licenses/NOTICE.txt`: separate processes, GPL-3.0 and GPL-2.0 with Classpath Exception respectively; retain exact corresponding-source references. |
| TraceMaker optional router | https://github.com/DingoOz/TraceMaker, GPL-3.0-or-later; generated archives include LICENSE, NOTICE, SOURCE.txt and dependency notices. |

Installers aggregate independently licensed components. Keep their notices and
corresponding source available alongside binary downloads as required by their
terms; the root license does not relicense those components. Optional commercial
CAD kernels are not included. JavaScript dependency licenses remain in their
installed package metadata and distribution notices.
