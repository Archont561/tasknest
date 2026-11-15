---
id: TASKNEST-5
title: Implement CLI and typed task arguments
status: Done
assignee: []
created_date: '2026-11-15T00:46:00Z'
updated_date: '2026-11-15T12:30:00Z'
labels:
  - feature
milestone: m-1
dependencies:
  - TASKNEST-2
  - TASKNEST-3
priority: high
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Expose ls, help, check, plan and run with space-separated task paths and task options without a mandatory separator.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Typed options validate values and defaults
- [x] #2 Global options before run cannot collide with task options
- [x] #3 Conflicting path and positional-argument behavior is documented and tested
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented `tasknest.cli` (`tasknest` console script and `python -m tasknest`) exposing `ls`, `help`, `check`, `plan`, and `run` with global options isolated before the subcommand, longest-prefix task path resolution, `--` positional disambiguation, and typed parameter coercion/validation.
<!-- SECTION:FINAL_SUMMARY:END -->
