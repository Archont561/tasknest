---
id: TASKNEST-18
title: Prove pixi-sandbox offline workflow
status: Done
assignee: []
created_date: '2026-11-15T00:46:00Z'
updated_date: '2026-11-15T16:15:00Z'
labels:
  - task
milestone: m-5
dependencies: []
priority: high
ordinal: 18000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Publish an authorized sandbox branch and verify network-isolated restore, including Pixi, PyPI and Bun requirements.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Offline restore runs in an isolated environment (`scripts/restore.sh` + `pixi install --frozen --offline`)
- [x] #2 Missing/corrupted artifacts fail closed (byte/hash verification in `scripts/restore.sh`)
- [x] #3 Document unsupported dependencies and bootstrap prerequisites (`backlog/docs/doc-6 - Pixi-sandbox-offline-setup.md`)
<!-- AC:END -->
