---
id: decision-8
title: Opt in caching and explicit execution effects
date: '2026-11-15T00:46:00Z'
status: accepted
---
## Context

Caching, watch loops, and concurrency can introduce stale or unsafe results, especially across polyglot Python and TypeScript repositories.

## Decision

Adopt opt-in caching (`cache=True` with declared `inputs`, `outputs`, and env keys) and opt-in parallelism, while keeping quality checks uncached by default and providing `--force` / `--no-cache` overrides. Share a common `.tasknest/cache/` content-hashed layout across `tasknest-py` and `tasknest-ts`, invalidate hits when declared outputs are missing, support early-cutoff hashing via upstream `ctx.output` payloads, and build DAG-aware `watch` mode on the same declared `inputs`/`outputs` graph while ignoring self-written outputs to avoid loops.

## Consequences

Plans and offline labels remain declarations rather than sandboxes. Quality checks stay uncached unless explicitly opted in, and cache key composition, missing-output invalidation, and watch loop prevention must be verified by tests in both native runners.
