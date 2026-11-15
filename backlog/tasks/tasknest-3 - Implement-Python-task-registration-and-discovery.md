---
id: TASKNEST-3
title: Implement Python task registration and discovery
status: Done
assignee: []
created_date: '2026-11-15T00:46:00Z'
updated_date: '2026-11-15T12:30:00Z'
labels:
  - feature
milestone: m-1
dependencies:
  - TASKNEST-2
priority: high
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement one tool per file and namespace discovery from configured roots, with underscore and reserved-directory exclusions.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Discover nested tools and list docstring descriptions
- [x] #2 Reject duplicate task names and invalid registrations
- [x] #3 Document that importing tools executes trusted code
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented `@tool`, `TaskDefinition`, `load_config` (using stdlib `tomllib` on Python `>=3.11` and `tomli` on Python `3.10`), and `discover_tasks` supporting configured roots, namespaces, `project_root`, docstring summaries, underscore/reserved exclusions, and duplicate/invalid-file rejection.
<!-- SECTION:FINAL_SUMMARY:END -->
