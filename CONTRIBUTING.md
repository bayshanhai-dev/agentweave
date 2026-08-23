# Contributing to AgentWeave

Thank you for helping improve AgentWeave. Contributions should make the runtime
safer, more observable, easier to operate, or more useful to humans supervising
agent hives.

## Before you start

1. Read the [README](README.md) and the current product boundaries in
   [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md).
2. Search existing issues and pull requests before opening a new one.
3. For security vulnerabilities, do not open a public issue. Follow
   [`SECURITY.md`](SECURITY.md).

## Development setup

Requirements: Docker Desktop, Node.js 22+, Corepack, and pnpm 11.

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm run doctor
pnpm run docker:up
```

Useful checks:

```bash
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run lint
```

Use `pnpm run docker:down` when finished. Do not commit `.env`, provider
credentials, workspace data, database volumes, or generated build output.

## Scope and design expectations

- Keep Control Plane code provider-neutral. Provider-specific calls belong in
  the execution plane/provider adapter.
- Preserve durable state transitions and idempotency when changing commands,
  tasks, runs, or events.
- Treat human approval and emergency-stop paths as safety-critical.
- Add or update tests for behavior changes, especially retry, pause/resume,
  recovery, and message routing.
- Avoid unrelated refactors and new P2 features during MVP work.
- Never log tokens, prompts containing secrets, or workspace credentials.

## Pull requests

Every pull request should explain:

- what changed and why;
- which user-visible behavior changed;
- how it was tested;
- any migration, configuration, or operational impact;
- known limitations and follow-up work.

Keep commits focused. Documentation changes should be separate from runtime
changes when practical. The maintainers may request changes before merging.

## Commit messages

Use a short imperative subject, for example:

```text
fix: prevent duplicate task dispatch after provider timeout
feat: add workstream approval command
docs: clarify provider adapter configuration
```

## License

By contributing, you agree that your contribution is provided under the
Apache License 2.0 in [`LICENSE`](LICENSE).
