---
id: TASKNEST-5
title: Implement CLI and typed task arguments
status: To Do
assignee: []
created_date: '2026-11-15T00:46:00Z'
updated_date: '2026-11-15T00:47:00Z'
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
- [ ] #1 Typed options validate values and defaults
- [ ] #2 Global options before run cannot collide with task options
- [ ] #3 Conflicting path and positional-argument behavior is documented and tested
<!-- AC:END -->
