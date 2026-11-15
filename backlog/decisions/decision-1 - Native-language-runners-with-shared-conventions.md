---
id: decision-1
title: Native language runners with shared conventions
date: '2026-11-15T00:45:00Z'
status: accepted
---
## Context

Two language ecosystems need native task APIs without embedded runtimes.

## Decision

Build independent pure-Python and pure-TypeScript task runners with shared conventions and behavioral specifications. The TypeScript runner must support both Bun and Node.js via explicit runtime adapters rather than hardcoding Bun-only runtime APIs in core logic.

## Consequences

Shared conformance fixtures are needed; cross-language graphs are not automatic. TypeScript core modules target runtime-neutral interfaces backed by Bun and Node.js adapters, and CI verifies both runtimes.
