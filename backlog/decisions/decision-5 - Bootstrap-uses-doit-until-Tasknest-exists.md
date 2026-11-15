---
id: decision-5
title: Bootstrap uses doit until Tasknest exists
date: '2026-11-15T00:46:00Z'
status: accepted
---
## Context

Tasknest is not implemented, but repository checks are needed now.

## Decision

Use doit via pixi run tools, with automation confined to tools/dodo.py.

## Consequences

Do not claim this is the Tasknest runtime. Migrate only once the new runner is proven.
