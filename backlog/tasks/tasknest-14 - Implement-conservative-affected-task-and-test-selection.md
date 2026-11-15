---
id: TASKNEST-14
title: Implement conservative affected task and test selection
status: To Do
assignee: []
created_date: '2026-11-15T00:46:00Z'
updated_date: '2026-11-15T15:50:00Z'
labels:
  - feature
milestone: m-4
dependencies:
  - TASKNEST-13
  - TASKNEST-17
  - TASKNEST-20
priority: medium
ordinal: 14000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Select tasks and affected test files using explicit reverse-dependency/import mappings (optionally computed and cached via `ctx.output(...)` and consumed via `ctx.deps[...]`), with conservative fallback to the full suite for global config/lockfile changes or unknown impact.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Unknown mappings, shared fixtures, global config/lockfiles, and unmapped renames/deletions trigger full suite or explicit failure
- [ ] #2 Language-specific import-graph tasks can cache reverse mappings via `ctx.output(...)` and feed `ctx.deps[...]`
- [ ] #3 Report selected tasks, test files, and fallback reasons
- [ ] #4 Support full-suite override (`--all` / `--force`)
<!-- AC:END -->
