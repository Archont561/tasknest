---
id: doc-5
title: Future capabilities and safety
type: specification
created_date: '2026-11-15T00:46:00Z'
---

# Future capabilities and safety

These are proposed capabilities, not currently available:

- `ctx.affected` carries explicit change provenance and file statuses; it does not itself prove which tests are affected. Include old paths for renames and deletions and expose missing change data.
- Affected task selection is distinct from passing change information to an explicitly selected task. Unknown impact defaults to the full relevant suite or a clear failure.
- Parallelism is opt-in, dependency-aware and must account for shared resources, cancellation, output and nested worker budgets.
- Caching is opt-in for declared inputs and outputs, visible in results and invalidated on missing output or relevant changes. Do not cache quality checks by default.
- JSON output and saved reports need a versioned schema, stable exit codes, separated diagnostics and a redaction policy. Redaction cannot guarantee no secret leakage.
- Plans resolve known dependencies without executing task bodies. Arbitrary Python cannot be predicted safely; a dry run must state when its view is incomplete.
- Offline and writes marks are declarations, not sandbox enforcement. Unknown task effects must not be represented as guaranteed safe.
- Jinja-generated skills must be deterministic, support non-writing drift checks and avoid overwriting user-maintained files without permission. Custom templates are trusted code.
