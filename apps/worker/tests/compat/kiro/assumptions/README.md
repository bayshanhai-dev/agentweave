# Assumption-based Kiro fixtures

These cases document the currently hypothesized stream JSON event schema and
defensive aliases that have not been established by published documentation or
captured-output provenance. They cover streaming, session persistence, usage,
malformed JSONL, and unknown events. They are intentionally excluded from both
`pnpm test` and the default `pnpm test:compat:kiro` profile. Run them explicitly
with `pnpm test:compat:kiro:assumptions`.
