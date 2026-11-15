---
id: TASKNEST-7
title: Implement strict structural validation and marks
status: Done
assignee: []
created_date: '2026-11-15T00:46:00Z'
updated_date: '2026-11-15T16:40:00Z'
labels:
  - feature
milestone: m-2
dependencies:
  - TASKNEST-3
  - TASKNEST-4
priority: high
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Validate declared marks, task descriptions, structure and optionally per-task tests and feature files.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Unknown marks are rejected under strict policy
- [x] #2 Test and feature presence checks are optional and do not claim coverage
- [x] #3 Mark filters include prerequisites and make effects explicit
<!-- AC:END -->
