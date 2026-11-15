---
id: doc-5
title: Future capabilities and safety
type: specification
created_date: '2026-11-15T00:46:00Z'
---

# Future capabilities and safety

These are proposed capabilities, not currently available:

- `ctx.affected` carries explicit change provenance and file statuses (`path`, `old_path`, `status`); it does not itself prove which tests are affected. Include old paths for renames and deletions and expose missing change data.
- Affected task and test selection is distinct from change context. Language-specific analysis tasks (such as cached reverse-import graph tasks emitting `ctx.output(...)`) feed conservative selectors that fall back to the full relevant suite on unknown impact, shared config/lockfile changes, or unmapped files, and report the selection reason.
- Parallelism is opt-in, dependency-aware and must account for shared resources, cancellation, output and nested worker budgets.
- `ctx.output(...)` buffers structured task outputs on `ToolContext` (committed only on success) and downstream tasks read them by canonical name via `ctx.deps["<task>"]`. JSON is the portable cross-runner default (`tasknest-py` and `tasknest-ts`); Python `pickle` is strictly opt-in, local-only, and keyed by Python version/environment (never unpickled from shared/remote caches).
- `ctx.env(name, default=...)` and task-local scoped env helpers read/set `base_env` without mutating global `os.environ` or `process.env`, and automatically record queried env vars in the task's cache key.
- Caching is opt-in for declared `inputs`, `outputs`, `env`, and upstream `ctx.output` hashes (enabling early-cutoff hits when a dependency's input file changes without changing its emitted `ctx.output`), visible in results, and invalidated on missing output, `--force`/`--no-cache`, or relevant changes. Do not cache quality checks by default.
- DAG-aware `watch` mode monitors the union of declared `inputs` across the target subgraph, ignores writes to a task's own declared `outputs` to prevent feedback loops, and re-runs only dirty nodes while restoring cached branches.
- JSON output and saved reports need a versioned schema, stable exit codes, separated diagnostics and a redaction policy. Redaction cannot guarantee no secret leakage.
- Plans resolve known dependencies without executing task bodies. Arbitrary Python cannot be predicted safely; a dry run must state when its view is incomplete.
- Offline and writes marks are declarations, not sandbox enforcement. Unknown task effects must not be represented as guaranteed safe.
- Jinja-generated skills must be deterministic, support non-writing drift checks and avoid overwriting user-maintained files without permission. Custom templates are trusted code.
