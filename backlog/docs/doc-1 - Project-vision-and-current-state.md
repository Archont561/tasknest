---
id: doc-1
title: Project vision and current state
type: specification
created_date: '2026-11-15T00:45:00Z'
---

# Vision and current state

Tasknest is intended to be a file-oriented task runner with native Python and TypeScript implementations and shared conventions. It targets the repetitive automation in Archont561 repositories: task registration, dependencies, quality gates, CLI arguments and execution reports.

## Current state (2026-11-14)

This repository is a scaffold, **not a working Tasknest runner**. `packages/python/` and `packages/tasknest/` contain minimal package skeletons. `tools/dodo.py` runs repository tasks using doit, exposed by `pixi run tools`. The proposed `tasknest.toml` is not consumed by a runner.

Implemented repository infrastructure includes Pixi and Bun locks, pytest/Bun smoke tests, tox configuration, Ruff, Rude with rude-clean-code, alint, actionlint, Lefthook/Convco, Jinja-generated README and AGENTS, GitHub CI configuration, and project skills. The multi-version CI matrix has not been run in this workspace. See `README.md` for current commands and `backlog/docs/doc-6 - Pixi-sandbox-offline-setup.md` for sandbox limitations.

## Scope and non-goals

The runner should complement environment managers such as Pixi, not silently install dependencies or publish packages. Plugins and ecosystem adapters are potential reuse mechanisms. Any later cross-language interoperability needs its own contract; two native runners do not automatically share an execution graph.

## Planning status

Backlog milestones describe proposed phases rather than commitments or release dates. Accepted decisions reflect directions explicitly agreed in conversation; details not yet selected are identified as proposals and must be validated by implementation tests.
