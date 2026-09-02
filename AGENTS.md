# Fabdesk — agent notes

- Bun 1.4.x monorepo. Run everything from the repo root: `bun install`, `bun run typecheck`, `bun test`.
- Never run `bun install` inside `vendor/fabplane` or `vendor/js_autorouter`.
- `vendor/*` are git submodules. Do not edit them here; change fabplane via a PR to `TensorFleet/fabplane.com` and bump with `bun run submodules:update`.
- Import fabplane's KiCad CLI helpers via the `@pcb/pcb/kicad-cli` subpath only. The package root pulls in sharp and the AWS SDK.
- Fabdesk code imports `zod/v4` (root pins zod 3.25.x so tscircuit gets v3).
- MCP tool names use underscores (`circuit_build`), never dots.
- `packages/router-freerouting` and `vendor/js_autorouter` are internal-only; anything shipped in a public build must not reference them.
- Relative imports are extensionless (`./events`, not `./events.ts`); `allowImportingTsExtensions` is off, matching fabplane.
- TypeScript is strict with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; use the `...(x ? { k: x } : {})` idiom for optional fields.
