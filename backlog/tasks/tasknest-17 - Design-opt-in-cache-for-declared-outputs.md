---
id: TASKNEST-17
title: Design opt in cache for declared outputs
status: Done
assignee: []
created_date: '2026-11-15T00:46:00Z'
updated_date: '2026-11-15T18:30:00Z'
labels:
  - feature
milestone: m-4
dependencies:
  - TASKNEST-4
  - TASKNEST-20
priority: medium
ordinal: 17000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement opt-in caching for declared file/directory `outputs` and `ctx.output(...)` payloads across `tasknest-py` and `tasknest-ts` using a shared `.tasknest/cache/` content-hashed layout, supporting early cutoff when upstream `ctx.output` values do not change and explicit local-only `pickle` serialization in Python.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Checks run uncached by default and `--force` / `--no-cache` bypasses cache
- [x] #2 Cache key hashes declared `inputs`, CLI options, tracked `ctx.env` / `env` vars, and upstream `ctx.output` hashes (supporting early cutoff)
- [x] #3 Missing declared `outputs` invalidate cache hits; JSON is the cross-runner default and Python `pickle` is opt-in local-only keyed by Python version/env
- [x] #4 Cache hits/misses and invalidation reasons are surfaced in runner output and reports
<!-- AC:END -->
