# AgentWeave Bug Report

Date: 2026-08-22
Scope: Dashboard regression and real Codex App Server E2E against AcademicPaperBuddy

## Executive summary

The latest real Codex E2E passed the main runtime loop:

```text
Dashboard → Workstream → Worker → Codex App Server → PM → PE → Backend → QA
→ workspace evidence → human approval → completed
```

The remaining issues below should be fixed before treating the MVP as production-ready.

## P0 — Codex result has no usable text summary

### Observed behavior

In the real Codex E2E, all four Provider turns completed, but the messages contained:

```text
Provider turn completed without a text summary.
```

The workflow still advanced and reached human approval, but the user could not see what Codex actually inspected or concluded.

### Impact

- PM/PE/QA messages are not meaningful.
- Human approval is based on an empty summary.
- The system can report QA pass without exposing the underlying result.

### Likely area

- `apps/worker/src/providers/codex-app-server.ts`
- Codex HTTP/App Server event normalization
- Worker result payload mapping in `apps/worker/src/main.ts`
- Control API `handleWorkerResult()` fallback behavior

### Acceptance criteria

- A successful Codex turn produces non-empty, human-readable text when the App Server returns text or deltas.
- The result preserves the final turn text in the persisted message and event.
- Empty provider output is treated as a failed or incomplete review, not an automatic pass.
- A regression test covers a streamed Codex response and final summary.

## P1 — Task and Evidence linkage is fragile across runs

### Observed behavior

The latest Codex run eventually persisted the task as `done` with four evidence IDs, but previous E2E runs showed:

- Workstream `completed` while Task remained `ready`.
- Message evidence IDs existed while `workspace_evidence` rows were missing.

This indicates task completion and evidence persistence are not transactionally consistent.

### Impact

- Summary can show `0/1` after completion.
- Human approval can occur without durable evidence.
- Restart or partial failure can leave contradictory state.

### Likely area

- `apps/worker/src/runtime/execution.ts`
- Control API worker-result handling
- Task persistence and evidence persistence ordering
- `workspace_evidence` repository/schema

### Acceptance criteria

- `task.completed` atomically updates the Task to `done` and stores all Evidence references.
- Evidence persistence failure prevents Task completion and emits `task.failed`.
- Workstream completion is blocked if its required Task is not `done`.
- A restart/retry test verifies no duplicate evidence and no contradictory task state.

## P1 — Codex E2E does not run an explicit QA command

### Observed behavior

The real Codex E2E produced workspace evidence with a zero Git diff, but no test command, test output, or test exit code was recorded.

### Impact

- “QA passed” does not prove that AcademicPaperBuddy was checked.
- Evidence records only the workspace diff.
- A read-only inspection is indistinguishable from a successful test run.

### Acceptance criteria

- Software-development Workstreams define an explicit lightweight QA command or clearly mark it as not run.
- Evidence records command, output, exit code, and timestamp.
- QA cannot pass silently when the required command was not executed.

## P1 — Provider and model configuration is not visible in the Dashboard

### Observed behavior

The Worker used `provider: codex` from container configuration, while Workstream creation exposed provider/model as metadata. The Dashboard does not clearly show the effective Provider, model, App Server endpoint, or connection status for the running Workstream.

### Impact

- Users cannot tell whether a run used Mock or Codex.
- A successful-looking E2E can accidentally be a Mock run.
- Provider configuration failures are difficult to diagnose.

### Acceptance criteria

- Dashboard shows effective Provider and model for each Workstream/run.
- Worker registration reports provider capability and connection health.
- Provider connection/configuration errors appear as visible Workstream events.
- Workstream metadata cannot disagree with the effective Worker Provider.

## P1 — Browser QA is not yet a Worker capability

### Observed behavior

The QA Agent can run Provider turns, but AgentWeave has no browser adapter/capability for navigation, DOM inspection, screenshots, clicks, or assertions.

### Impact

- QA Agent cannot perform Dashboard/browser regression testing like the operator.
- Browser evidence cannot be generated or audited by the runtime.

### Acceptance criteria

- Browser is modeled as an optional Worker capability, not a hard dependency of the core runtime.
- QA can request navigation, snapshot, click, fill, screenshot, console logs, and assertions within an approved scope.
- Browser actions and screenshots become durable Evidence.
- Browser permissions and allowed origins are policy-controlled.

## P2 — Generic Evidence must not hard-depend on Git

### Observed behavior

An earlier E2E failed with `spawn git ENOENT` because the Worker image did not contain Git. The current runtime now supports workspace evidence, but Git is still embedded in the generic evidence path.

### Impact

- Non-software Workstreams may fail because Git is unavailable.
- A missing optional capability can block the whole Task.

### Acceptance criteria

- Evidence collection is pluggable: Git, filesystem snapshot, command output, browser, document, etc.
- Missing Git produces a structured capability warning, not an unconditional Worker failure.
- Software-development Flavor may require Git explicitly.
- Other Flavors can use non-Git Evidence collectors.

## Verification record

Latest real Codex E2E:

- Provider: Codex App Server
- Target: `/workspaces/academic-paper-buddy`
- Agent Sessions: PM, PE, Backend, QA all completed
- Evidence: four workspace evidence records
- Git diff: zero
- Task: done
- Workstream: completed after human approval
- No source files changed in AcademicPaperBuddy
