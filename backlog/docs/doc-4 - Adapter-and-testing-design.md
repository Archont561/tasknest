---
id: doc-4
title: Adapter and testing design
type: specification
created_date: '2026-11-15T00:46:00Z'
---

# Adapter and testing design

Proposals for later work, not implemented APIs.

Core should supply a context, a safe argv-based command runner and result/error reporting. Adapters should handle tool-specific operations and respect explicit working directory, environment and side effects. Candidate built-in modules include Cargo, pytest, Ruff, Bun, Node.js/npm, actionlint, alint, Convco, Vale and gherlint. Installing an adapter must not implicitly install or run its external executable.

In the TypeScript implementation, core discovery, graph execution, and CLI logic must depend on runtime host adapters (filesystem, globbing, process spawning, environment/argv) with dedicated **Bun** and **Node.js** adapters so `tasknest` executes natively on both Bun (`>=1.1`) and Node.js LTS (`>=20`) without hardcoding `Bun.*` APIs in shared core modules.

A pytest adapter could expose `Pytest(ctx).run()` and `run_affected()`. Task selection and test selection are distinct. The task or adapter must use a trustworthy project-specific mapping; when unavailable or incomplete it should run the full suite by default and explain why. Deleted/renamed old paths and shared configuration must be considered.

Optional package plugins `tasknest-<plugin>` could offer additional adapters and task factories. A factory can be explicitly registered in a tool file; installation alone should not register tasks. API compatibility and native Python/TypeScript implementations need explicit versioning.

A proposed `tasknest.testing.CliRunner` tests discovery, CLI parsing and graph behavior in-process, returning exit code, output and exception. Separate subprocess tests remain necessary for installed executables, environment and signals; neither mode is a sandbox.
