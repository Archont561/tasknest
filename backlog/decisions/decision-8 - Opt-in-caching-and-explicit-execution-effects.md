---
id: decision-8
title: Opt in caching and explicit execution effects
date: '2026-11-15T00:46:00Z'
status: proposed
---
## Context

Caching and concurrency can introduce stale or unsafe results.

## Decision

Propose opt-in caching and parallelism, with uncached quality gates and declared effects.

## Consequences

Plans and offline labels are not sandboxes. The safety contract must be tested before adoption.
