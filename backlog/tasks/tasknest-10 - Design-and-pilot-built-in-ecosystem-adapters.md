---
id: TASKNEST-10
title: Design and pilot built-in ecosystem adapters
status: To Do
assignee: []
created_date: '2026-11-15T00:46:00Z'
updated_date: '2026-11-15T00:47:00Z'
labels:
  - feature
milestone: m-2
dependencies:
  - TASKNEST-6
priority: medium
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Pilot Cargo, Ruff, pytest or actionlint wrappers based on actual repository workflows; retain a command escape hatch.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Adapters use shared subprocess and result handling
- [ ] #2 External executable availability is diagnosed without installing it
- [ ] #3 Affected pytest behavior falls back safely when mapping is unknown
<!-- AC:END -->
