# Connections form human-test — November 5, 2026

Existing native fabPlane Dev, same preserved VAIO test profile. User screenshot: two boards selected, both port menus empty, Add connection disabled with no explanation. Root cause: validation returned “Choose both ports” but the UI hid that message until both ports were already selected.

Fix: visible Board and Port labels; board/connector-specific placeholders and guidance for the exact missing endpoint; connect guidance to disabled Add through aria-describedby. Initial incomplete steps use neutral status styling; invalid complete selections retain errors. The page identifies this as a mechanical cable guide and does not imply electrical compatibility.

User approved taking over briefly after native automation detected their manual input. Their current unsaved placement and three-board enclosure selection were preserved; no native source editing or project reset was used. Navigation used the visible Boards area menu → Mechanical → Connections. Accessibility option actions left the styled picker open; Escape closed it before the next visible action. This is recorded tool friction. Screen capture failed once during destination-port selection; the following observation confirmed the selection had completed.

| Step | Expected | Visible actual outcome | Status / evidence |
| --- | --- | --- | --- |
| Open Connections | Explain prerequisites | Board/Port labels and “Choose a board and connector for each end” | Passed — 01 |
| Select carrier and I/O | Explain why Add is disabled | “Choose a connector in both Port menus…” | Passed — 04 |
| Choose carrier J101 | Name remaining step | “Choose the To port…” | Passed |
| Choose I/O J4 | Enable valid guide | Add enabled; 63.3 mm between ports displayed | Passed — 02 |
| Click Add connection | Add exactly one guide | J101 → J4 entry, carrier → I/O, 63.3 mm / 100 mm cable; form resets | Passed — 03 |
| Remove temporary guide | Restore initial connection list | Removed exactly the test entry; no connection remains | Passed |
| Restore the two board dropdowns | Leave the reported state understandable | Carrier and I/O selected, ports empty with explicit guidance | Passed — 04 |

No cable was saved/applied, no electrical compatibility verified, and no native PCB/schematic edit occurred. A clearly visible 3D cable path was not established by this test; only the connection entry and distance were verified. Port candidates still include conservatively detected non-connector footprints (D401/U2); that separate UX finding remains open.

Checks: UI typecheck passed;366 UI tests/4135 assertions passed;3 connection tests/16 assertions passed; desktop build passed in39.95s. Source diagnostics and automated checks are separate from the visible walkthrough. All captures are unaltered;00 is explicitly user-provided baseline evidence.
