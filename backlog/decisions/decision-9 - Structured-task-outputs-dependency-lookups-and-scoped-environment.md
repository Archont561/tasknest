---
id: decision-9
title: Structured task outputs, dependency lookups, and scoped environment
date: '2026-11-15T15:50:00Z'
status: accepted
---
## Context

Overloading task return values conflicts with ordinary Python/TypeScript return types, prevents incremental emission, and breaks cross-file decoupling under Tasknest's one-task-per-file discovery model. Mutating global `os.environ` or `process.env` is also unsafe for parallel execution and deterministic cache keys.

## Decision

Expose structured task outputs through `ctx.output(...)` rather than task return values, and expose upstream outputs to dependents via `ctx.deps["<canonical.task.name>"]` (buffered in memory and committed only on task success). Default `ctx.output(...)` to JSON for cross-language portability between `tasknest-py` and `tasknest-ts`; allow Python `pickle` only as an explicit, opt-in local-only format keyed by Python version and environment. Provide `ctx.env(name, default=...)` and scoped task-local environment helpers on `ToolContext` so read variables are tracked in cache keys without mutating global process environment.

## Consequences

Tasks remain decoupled across files and languages without cross-importing modules. `ctx.deps` restricts reads to declared `depends` entries, and `pickle` payloads are never shared across languages or treated as safe remote cache artifacts.
