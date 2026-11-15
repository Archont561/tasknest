---
id: TASKNEST-6
title: Add execution context and subprocess helper
status: Done
assignee: []
created_date: '2026-11-15T00:46:00Z'
updated_date: '2026-11-15T12:30:00Z'
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
- [x] #1 Nonzero exits and timeouts fail tasks
- [x] #2 Commands are executed without a shell by default
- [x] #3 Context distinguishes repository and configured project roots
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Implemented `ToolContext`, `CommandResult`, and `ToolError` in `tasknest.context` with separate `repo_root` and `project_root`, explicit `cwd` and `env` overrides, `shell=False` argv execution, and `ToolError` on nonzero exit, timeout, or missing executable.
<!-- SECTION:FINAL_SUMMARY:END -->
