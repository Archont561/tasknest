---
id: decision-4
title: Task metadata and marks
date: '2026-11-15T00:46:00Z'
status: accepted
---
## Context

Tasks have different dependencies, requirements and selection labels.

## Decision

Use tool metadata for task dependencies, external requirements and marks; define simple mark descriptions in tasknest.toml.

## Consequences

Marks are declarations, not sandboxing. Exact decorator syntax and metadata merging remain design work.
