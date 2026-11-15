---
id: TASKNEST-14
title: Implement conservative affected task and test selection
status: To Do
assignee: []
created_date: '2026-11-15T00:46:00Z'
updated_date: '2026-11-15T00:47:00Z'
labels:
  - feature
milestone: m-4
dependencies:
  - TASKNEST-13
priority: medium
ordinal: 14000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Select tasks and tests only with explicit mappings, with conservative fallback for unknown impact.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Unknown mappings trigger full suite or explicit failure
- [ ] #2 Report selected tasks and tests and reasons
- [ ] #3 Support full-suite override
<!-- AC:END -->
