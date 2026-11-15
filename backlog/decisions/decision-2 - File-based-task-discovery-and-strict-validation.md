---
id: decision-2
title: File based task discovery and strict validation
date: '2026-11-15T00:46:00Z'
status: accepted
---
## Context

Repositories benefit from predictable discoverability.

## Decision

Use file-based namespaced discovery, one task per file, underscore exclusions and reserved tests/features directories; strict checks are optional.

## Consequences

Imports can execute code. Structural presence is not proof of coverage. The current doit bootstrap is separate.
