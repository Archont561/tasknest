---
id: TASKNEST-11
title: Implement native TypeScript discovery and CLI
status: To Do
assignee: []
created_date: '2026-11-15T00:46:00Z'
updated_date: '2026-11-15T00:47:00Z'
labels:
  - feature
milestone: m-3
dependencies:
  - TASKNEST-2
priority: high
ordinal: 11000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement a pure TypeScript runner without embedding the Python runner, backed by explicit Bun and Node.js runtime adapters so discovery, subprocesses, and CLI execution work on both Bun and Node.js LTS.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Implement discovery and sequential execution against shared fixtures
- [ ] #2 Preserve agreed CLI naming and error behavior
- [ ] #3 Provide Bun and Node.js runtime adapters and verify tests and packaging on both runtimes
<!-- AC:END -->
