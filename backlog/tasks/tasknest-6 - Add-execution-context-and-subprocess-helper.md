---
id: TASKNEST-6
title: Add execution context and subprocess helper
status: To Do
assignee: []
created_date: '2026-11-15T00:46:00Z'
updated_date: '2026-11-15T00:47:00Z'
labels:
  - feature
milestone: m-1
dependencies:
  - TASKNEST-2
priority: high
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Provide ToolContext, ToolError and argv-based subprocess execution with explicit cwd and environment.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Nonzero exits and timeouts fail tasks
- [ ] #2 Commands are executed without a shell by default
- [ ] #3 Context distinguishes repository and configured project roots
<!-- AC:END -->
