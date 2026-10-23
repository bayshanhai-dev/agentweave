# Kiro compatibility profiles

`pnpm test:compat:kiro` runs only evidence-derived behavior. The command flags,
stdin contract, working-directory behavior, resume flag, process exit behavior,
and authentication mode come from Kiro's public headless/CLI documentation:

- https://kiro.dev/docs/cli/headless/
- https://kiro.dev/docs/cli/reference/cli-commands/
- https://kiro.dev/docs/getting-started/authentication/

The exact `stream-json` event schema is not published in those sources. Tests
for the currently supported event-shape hypotheses are therefore isolated under
`assumptions/` and run only with `pnpm test:compat:kiro:assumptions`. They are
also excluded from the Worker's ordinary `pnpm test` discovery.

Each profile has a separate local fake executable under its own `fixtures/`
directory; neither invokes Kiro, the network, nor an account.
