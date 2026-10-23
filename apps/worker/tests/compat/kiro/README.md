# Kiro compatibility profiles

`pnpm test:compat:kiro` runs only evidence-derived behavior. The command flags,
stdin contract, working-directory behavior, resume flag, process exit behavior,
and authentication mode come from Kiro's public headless/CLI documentation:

- https://kiro.dev/docs/cli/headless/
- https://kiro.dev/docs/cli/reference/cli-commands/
- https://kiro.dev/docs/getting-started/authentication/

The exact `stream-json` event schema is not published in those sources. What
the 2.x CLI actually emits — ACP `session/update` notifications
(`agent_message_chunk` …), `runFinished` / `runError` terminal events, and
credit-denominated usage (`creditsUsed` / `meteringUsage`) — was established
from the kiro-cli 2.33.1 ACP documentation and the shipped binary's event and
field names, after the originally assumed flat record shapes proved wrong
against a real 2.33.1 install (every turn failed). The unit tests in
`apps/worker/tests/providers/kiro-jsonl.test.ts` pin the normalized shapes; a
recorded authenticated live capture is still outstanding. Tests for remaining
event-shape hypotheses are isolated under `assumptions/` and run only with
`pnpm test:compat:kiro:assumptions`. They are also excluded from the Worker's
ordinary `pnpm test` discovery.

Each profile has a separate local fake executable under its own `fixtures/`
directory; neither invokes Kiro, the network, nor an account.
