---
id: TASKNEST-16
title: Add versioned machine readable reports
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
ordinal: 16000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Report results and task states using a versioned JSON schema and stable exit codes.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 JSON output is not mixed with progress output
- [x] #2 Pass fail skip and blocked are distinguishable
- [x] #3 Commands and diagnostics are redacted according to policy
<!-- AC:END -->
