---
id: TASKNEST-4
title: Implement dependency graph and sequential execution
status: To Do
assignee: []
created_date: '2026-11-15T00:46:00Z'
updated_date: '2026-11-15T00:47:00Z'
labels:
  - feature
milestone: m-1
dependencies:
  - TASKNEST-3
priority: high
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Support dependencies by task references or canonical strings; make failures block dependents.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Detect cycles and unknown dependencies before execution
- [ ] #2 Run a shared dependency once per invocation
- [ ] #3 Return nonzero on failures and report blocked tasks
<!-- AC:END -->
