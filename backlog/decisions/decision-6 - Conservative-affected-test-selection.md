---
id: decision-6
title: Conservative affected test selection
date: '2026-11-15T00:46:00Z'
status: accepted
---
## Context

Users want to run affected test suites without silently missing tests.

## Decision

Expose changed-file context separately from task selection; language-specific adapters own mappings and fall back conservatively.

## Consequences

Unknown changes, shared fixtures and deleted/renamed files require full testing or explicit failure.
