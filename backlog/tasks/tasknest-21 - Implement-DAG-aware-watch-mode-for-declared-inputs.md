---
id: TASKNEST-21
title: Implement DAG-aware watch mode for declared inputs
status: Done
assignee: []
created_date: '2026-11-15T15:50:00Z'
updated_date: '2026-11-15T18:30:00Z'
labels:
  - feature
milestone: m-4
dependencies:
  - TASKNEST-17
priority: medium
ordinal: 21000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add a `watch` CLI command that watches declared `inputs` across a target task's dependency subgraph, ignores writes to declared `outputs`, and re-executes only the minimal dirty subgraph using cached hits and early-cutoff `ctx.output(...)` invalidation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 `tasknest watch <task>` monitors declared `inputs` across the resolved DAG in both `tasknest-py` and `tasknest-ts` (via `RuntimeAdapter` for Bun and Node.js)
- [x] #2 Writes to a task's own declared `outputs` and unchanged content hashes do not trigger infinite watch loops
- [x] #3 Early cutoff via `ctx.output(...)` skips downstream tasks when an upstream file changes without changing its emitted output (e.g. `pyproject.toml` edit without version bump)
<!-- AC:END -->
