/** Shared with the MCP resource registration so the start map's pointer cannot drift. */
export const BOARD_WORKFLOW_RESOURCE_URI = "fabdesk://docs/board-workflow";

/** Short project entry map; detailed stage instructions remain in BOARD_WORKFLOW_MD. */
export const BOARD_START_MAP_MD = `## Start here

Use the path that fits the request. If a Fabdesk tool is not listed directly, use \`capability_search\` and \`capability_call\` when offered; otherwise use the client's tool discovery.

### New-board inputs

Before a new board's first \`board_check\`, it needs its parts, an outline, and connectors and other fixed parts at their intended position, rotation and side, because \`board_check\` records them as anchors.

- \`circuit_build\`: creates the schematic and board, including an outline when none exists and board dimensions or outline points are supplied. Outside template projects, \`board.placements\` sets x and y only.
- \`schematic_edit\`: edits the schematic only; \`pcb_update_from_schematic\` \`{"apply": true}\` brings parts to the board and \`pcb_define_outline\` sets the outline.
- For either path, \`pcb_place\` sets position, rotation and side (\`flip\`).

- \`circuit_source {"action": "schema"}\` returns the format of \`circuit.netlist.json\`; \`{"action": "validate"}\` checks a saved file.
- \`schematic_inspect\` with \`detail: "authoring"\` returns pins, unit numbers and item IDs.
- Parts: \`circuit_search_parts\` searches footprints unless \`kind\` is \`"symbol"\`. Use exact \`libId\` values from its results and check pins with \`circuit_describe_part\`.

| Request | First step | Then |
| --- | --- | --- |
| New board | Choose \`circuit_build\` or \`schematic_edit\`; get the board ready | \`board_check\` → layout → review → \`render_publish\` |
| Change an existing board | \`board_check\` (onboards it if needed) | \`board_edit\` \`mode: "impact"\` → \`mode: "full", adopt: true\` → \`board_check\` → \`render_publish\` |
| Connect open nets, fix DRC | \`board_check\` | \`board_route\` \`new\` → \`try\` → \`validate\` → \`accept\` |
| Review a board | \`board_review {"action": "run"}\` | Settle findings; \`autopilot\` applies proven fixes and leaves the owner's questions |
| Say where a board stands | \`board_check\` | Report its result and next step |
| Prepare fabrication files | Check the review gate | \`board_release\` |

### Board stages

\`\`\`
onboard ─► layout ─► last mile ─► review ─► release
              ▲                      │
              └──── edit ◄───────────┘   every edit makes the review stale
\`\`\`

| Stage | Tool | Move on when |
| --- | --- | --- |
| Onboard and check | \`board_check\`; after reviewing its proposals, \`{"confirm": true}\` | Requirements are confirmed |
| Layout | \`board_route\` \`check\`; \`place\`, \`rank\`, \`route\` when placement or first routing is needed | Few enough nets remain open |
| Last mile | \`board_route\` \`new\`, \`try\` with \`actions: ["finish"]\` (or \`["opens"]\` for a few nets), \`why\`, \`validate\`, \`accept\` | A1-A9 pass |
| Edit | \`board_edit\`: \`plan\`, \`mode: "impact"\`, then \`mode: "full", adopt: true\` (repair and proof included) | No collateral changes |
| Review and silkscreen | \`board_review\`, \`board_silk\` | Every finding is settled; no label problems |
| Release | \`board_release\` | Its gates pass |

A1-A9 are the board's own acceptance checks: connectivity, DRC, schematic/PCB parity, circuit, anchors, stack, power widths, differential pairs and heights. A board that arrived failing is judged by no new failure.

### Rules

- For a "change only this" task, accept a candidate that changed no other net (the \`~scoped\` one), never splice copper by hand.
- Never copy a candidate's board or project file by hand: adopt also carries the requirements.
- Starting an independent reviewer on the expert pack costs an agent run: ask first.
- Ask the owner only for what intent does not decide, recommended option first.
- Hard limits come only from the owner's intent and project policy: hard constraints, interconnect contracts, no powered work, purchases or supplier messages.

### More detail

Before dense layout, floorplans, differential pairs, courtyard refits, impedance or cable checks, special edit plans, or a release stop, read the full method: the MCP resource \`${BOARD_WORKFLOW_RESOURCE_URI}\` from the configured Fabdesk MCP server \`{{MCP_SERVER_NAME}}\`.
`;
