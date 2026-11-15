---
id: TASKNEST-15
title: Design parallel scheduler and resource safety
status: Done
assignee: []
created_date: '2026-11-15T00:46:00Z'
updated_date: '2026-11-15T18:30:00Z'
labels:
  - feature
milestone: m-4
dependencies:
  - TASKNEST-4
priority: medium
ordinal: 15000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Add opt-in dependency-aware concurrency and avoid uncontrolled nested worker counts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Failed prerequisites block dependents
- [x] #2 Independent output is attributable and cancellation is handled
- [x] #3 Resource conflicts and worker budgets are specified
<!-- AC:END -->
