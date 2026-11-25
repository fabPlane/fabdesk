# Google Antigravity in FabDesk

1. On the machine running FabDesk Core, install [Google's Antigravity CLI](https://antigravity.google/docs/cli-getting-started). The desktop Antigravity app is optional. Check that `agy acp --help` works.
2. Sign in on that machine with `agy acp --login`. FabDesk does not collect the Google credentials.
3. Open a project in FabDesk and select **Agent & model → Google Antigravity → Agent setting**. This uses the model from Antigravity. To set an explicit account-supported model ID, use **Settings → Agents**. If FabDesk cannot find the CLI, set its binary path there (typically `~/.local/bin/agy` on macOS).

FabDesk connects over [ACP](https://antigravity.google/docs/cli/acp/) and supplies its project tools through the per-run HTTP MCP connection. It streams responses and tool activity and can reload a prior Antigravity conversation. It starts the CLI with terminal sandbox restrictions enabled. FabDesk shows one-time approvals for requests that Antigravity sends to it; it does not change the CLI's existing permission rules. FabDesk's strict Supervised and planning-only modes are not supported by this harness.

Model availability, personal settings, installed extensions, and any other tool integrations remain under Antigravity's control. The normal Antigravity service receives your prompts and any project context the CLI collects. Start with a disposable project if you want to test that setup before opening your own work.
