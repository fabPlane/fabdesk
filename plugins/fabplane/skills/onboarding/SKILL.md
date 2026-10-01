---
name: onboarding
description: Check that fabPlane is installed and reachable, point out a missing sign-in for shopping lists, then open the fabPlane Boards view. Use when the user chooses Set up for fabPlane or asks for onboarding.
---

# Set up fabPlane

1. Call `pcb_environment` with `{}`. If the `fabdesk` server is not reachable, tell the user to
   install the fabPlane desktop app from https://fabplane.com, run
   `fabdesk-core install-cli` once (it links `fabdesk` into `~/.local/bin`) and make sure that
   folder is on `PATH`, then restart the host. On Windows, add the app's `resources\core` folder to
   `PATH` instead. Stop there.
2. Summarize what it reports in one or two lines: KiCad found or not, and the projects available.
   Mention a missing KiCad only as something render, DRC and export tools will need.
3. Call `board_viewer` with `{}` to open fabPlane Boards and invite the user to pick a project.
4. Ask whether they use shopping lists. If yes, call `shopping_list_viewer` with `{}`. If it
   reports that fabplane.com is not connected, tell them to sign in from the fabPlane app
   (Settings -> Account); do not ask for credentials in chat.

If the user installed the plugin in the middle of a task, continue that task in the same
conversation after step 3.
