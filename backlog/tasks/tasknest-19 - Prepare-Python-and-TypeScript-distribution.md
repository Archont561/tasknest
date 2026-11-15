---
id: TASKNEST-19
title: Prepare Python and TypeScript distribution
status: Done
assignee: []
created_date: '2026-11-15T00:46:00Z'
updated_date: '2026-11-15T16:15:00Z'
labels:
  - task
milestone: m-5
dependencies:
  - TASKNEST-5
  - TASKNEST-11
priority: medium
ordinal: 19000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Define package names, versioning, artifact validation and install smoke tests without implicit publishing.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Build and install artifacts in clean environments (`py_compat`, `ts_compat`, `tools/build.py`)
- [x] #2 Validate CLI entry points and supported runtimes (Python 3.10–3.14, Bun 1.1/1.4/latest, Node 20/22/24)
- [x] #3 Publishing remains explicit and credential-independent until requested (tag-gated `release.yml` + `release_check`)
<!-- AC:END -->
