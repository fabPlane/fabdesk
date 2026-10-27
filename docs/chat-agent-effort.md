# Chat agent effort

The **Agent & model** menu in the chatbox now includes a **Reasoning effort** section directly above **Model settings**. It lists only levels reported for the selected model. Each choice includes a short explanation of the speed/reasoning tradeoff.

The chatbox button shows the model followed by its effective effort, for example **GPT-6 Astra High**. **Auto** means the app is delegating to the agent's settings; models with no advertised effort control show only the model name. The same label is available to screen readers and in the button tooltip.

- Preferences are saved per agent in the local daemon settings (`agents[id].effort`), survive restarts, and apply to subsequent runs across chats, including queued messages and Finish it runs when they start. A run already in progress is unchanged. The picker is disabled while this chat is running or has queued messages, like the model picker.
- **Agent default** removes the app's override and delegates effort to the CLI's own settings/session behavior. It does not guarantee a particular numeric/default level on a resumed session.
- If a saved level is unavailable for a newly selected model, the UI shows Auto and the daemon omits that override. The preference remains saved for models that support it.
- Saving disables send/model/effort controls until the server responds. Failures keep the old value and show an error. Saving effort does not reset a locally selected agent or model.
- Effort saves use a narrow daemon endpoint that merges only that agent's effort into the latest settings. Concurrent model changes retain both choices and unrelated settings.
- Old settings need no migration. Effort is local to this installation; it is not added to cloud settings sync.

## Agent support

Codex reads model-specific capabilities from its existing `models_cache.json`, respecting `CODEX_HOME` and the same home precedence as the adapter. It forwards an explicit choice with `-c model_reasoning_effort=...` for exec/resume and `effort` on app-server `turn/start`. A missing/invalid catalog or an unknown model leaves the menu disabled rather than guessing which levels work. Open the CLI once to populate its catalog if necessary.

Claude uses `supportsEffort` and `supportedEffortLevels` from the existing initialization-only model probe, preserving the reported aliases and resolved IDs. It passes the selected level through `--effort` before the variadic tool allowlist. Catalog inspection does not send a user prompt.

Cursor/Grok and models without advertised capabilities retain their own defaults. This change does not invent CLI flags for them. Local catalogs may be stale, and model/provider policy can still limit the agent's actual effort.

References: [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference), [Codex app server](https://learn.chatgpt.com/docs/app-server), [Claude model/effort configuration](https://code.claude.com/docs/en/model-config#adjust-effort-level). Capability lists come from the installed agents, not hard-coded documentation snapshots.

## Validation

- Tests cover capability parsing, aliases, unsupported values, fresh/resumed CLI arguments, app-server turn parameters, persisted settings after a database reopen, and supported/unsupported choices reaching the run manager.
- Live desktop checks cover saving High, retaining the selected model and other agent settings, reload persistence, switching agents, unsupported Haiku/Cursor choices, keyboard End/Escape and focus return, and a simulated save failure.
- Six real installed-agent smoke runs passed: Codex exec and app-server with GPT-6 Astra, and Claude print with Opus 5, each using Low on a fresh session and High on its resumed session. Each returned the requested marker with exit code 0 and no tool calls, using an empty temporary project and test MCP server. This confirms accepted execution, not a measurable answer-quality difference between levels.
- Final label checks cover High, Low, Auto, unsupported saved levels, and models without effort controls. Live selection and renderer reload retained **GPT-6 Astra High**; the original local preference was restored afterward.
- Repository type checking passed. All 214 UI and 166 client-core tests passed. The full Windows suite had the same 34 failing test names as unchanged `main` at `519cc3c3`; these baseline failures are not a clean full-suite pass.

This branch includes the New Chat/default-agent fixes from PR #384 and resolves their composer overlap. Merge #384 first, then this PR; both target `main`.

## Try it

Open **Agent & model**, choose a supported Codex or Claude model, then expand **Reasoning effort** above **Model settings** and choose a level. Reload the app to check persistence, or switch agents and back to check their separate preferences. Higher effort can use more time and tokens. Choose **Agent default** to return control to the agent.
