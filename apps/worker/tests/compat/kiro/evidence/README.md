# Evidence-derived Kiro fixtures

This default profile covers only behavior documented by Kiro: command flags,
piped stdin, cwd, resume/model arguments, cancellation, and stderr/exit status
failures. It deliberately emits no JSONL records because the precise event
schema is not published. The executable fixture is local and deterministic; it
never contacts Kiro or the network.

Run this default compatibility profile with `pnpm test:compat:kiro`.
