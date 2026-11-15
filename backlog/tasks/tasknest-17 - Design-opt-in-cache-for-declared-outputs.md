---
id: TASKNEST-17
title: Design opt in cache for declared outputs
status: To Do
assignee: []
created_date: '2026-11-15T00:46:00Z'
updated_date: '2026-11-15T00:47:00Z'
labels:
  - feature
milestone: m-4
dependencies:
  - TASKNEST-4
priority: low
ordinal: 17000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement or explicitly defer safe incremental execution with visible cache decisions.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Checks run uncached by default
- [ ] #2 Cache key includes declared inputs and relevant configuration
- [ ] #3 Missing outputs and forced runs invalidate hits
<!-- AC:END -->
