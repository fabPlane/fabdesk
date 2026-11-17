/** Shared by chat board instructions and Finish it. */
export const FINISH_BOARD_PROMPT = `Finish the board for fabrication.
Before any work, gather owner-only decisions together at the start: bare board or assembly; via-in-pad policy
when status or review already shows vias in pads; and anything in intent preferences.ask_owner_for.
Use one request_user_input call per question. Wait for those answers before dependent work.
The finish request authorizes starting the whole-board independent reviewer without asking again.
Then run checks → review → fixes → independent review and import → release check → board_release fab → one report.
Apply net classes with board_check applyRules:true before review if needed.
A geometry change is its own named edit task; after it run checks and review again. Release never changes copper.
For fill and cap, record the owner's manufacturing_rules.filled_capped_vias decision with its reason before
board_release vias apply:true; then checks and review again because the fabrication attributes changed.
For assembly, run board_release bom before fab. Finish only when fab succeeds for the current design.
After the initial owner questions run to the end without further cards; report unresolved owner-only blockers instead
of inventing decisions. Publish previews once at completion and give one report.`;
