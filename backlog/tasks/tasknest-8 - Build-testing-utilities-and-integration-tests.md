---
id: TASKNEST-8
title: Build testing utilities and integration tests
status: To Do
assignee: []
created_date: '2026-11-15T00:46:00Z'
updated_date: '2026-11-15T00:47:00Z'
labels:
  - feature
milestone: m-2
dependencies:
  - TASKNEST-5
  - TASKNEST-6
priority: high
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Provide an in-process CliRunner plus subprocess integration tests for installed CLI behavior.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 CliRunner exposes exit code stdout stderr and exception
- [ ] #2 Subprocess tests cover installed entry point and failure behavior
- [ ] #3 Tests isolate fixture projects
<!-- AC:END -->
