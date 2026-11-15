---
id: decision-3
title: CLI task paths and direct arguments
date: '2026-11-15T00:46:00Z'
status: accepted
---
## Context

Task names should be readable while task options remain convenient.

## Decision

Use space-separated nested CLI names and allow task flags without mandatory --. Use canonical dotted strings for references. Global options precede run.

## Consequences

Parser must define path and positional ambiguity and include tests; tg shorthand remains optional.
