---
id: TASKNEST-20
title: Add ctx.output, ctx.deps, and ctx.env context APIs
status: To Do
assignee: []
created_date: '2026-11-15T15:50:00Z'
updated_date: '2026-11-15T15:50:00Z'
labels:
  - feature
milestone: m-4
dependencies:
  - TASKNEST-6
  - TASKNEST-11
priority: high
ordinal: 20000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add `ctx.output(...)`, read-only `ctx.deps["<canonical.task.name>"]`, and `ctx.env(...)` + task-local scoped environment helpers to `ToolContext` in both `packages/tasknest-py` and `packages/tasknest-ts`.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 `ctx.output(...)` buffers structured outputs during execution, validates JSON serializability immediately (with opt-in local `pickle` in Python), and commits only on task success
- [ ] #2 Downstream tasks access upstream outputs via `ctx.deps["<canonical_name>"]` (restricted to declared `depends`) without cross-file imports
- [ ] #3 `ctx.env(name, default=...)` reads from task-local `base_env` over process env and records accessed keys for caching; scoped env setters never mutate global `os.environ` or `process.env`
- [ ] #4 `packages/tasknest-py` and `packages/tasknest-ts` share identical JSON semantics and pass all quality/parity checks
<!-- AC:END -->
