---
id: doc-2
title: Runner model and CLI contract
type: specification
created_date: '2026-11-15T00:46:00Z'
---

# Runner model and CLI contract

This is a **design proposal**, not implemented behavior. `TASKNEST-2` must resolve the remaining edge cases before it is considered normative.

## Discovery and definitions

A configured tool root discovers one task per file; nested directories provide namespaces. Ignore underscore-prefixed paths, including `_asset/`; root `tests/` and `features/` are reserved support paths. Root mappings provide namespace and project root. Duplicate names should fail validation. Docstrings provide descriptions.

Illustrative Python definition:

```python
@tool(depends=["format.check", "test"], marks=["fast"], requires=["cargo"])
def lint(ctx: ToolContext, fix: bool = False):
    """Lint the workspace."""
```

Decorator forms and an imported plugin task definition are proposed alternatives; precise registration semantics are open. Module import executes arbitrary Python, so discovery is not a sandbox.

## CLI

```text
tasknest ls
tasknest help check dev
tasknest plan check dev
tasknest run check dev
tasknest run lint --path src --fix
tasknest --format json run lint --format concise
```

Task paths use spaces; canonical references use dots. Task options need no mandatory `--`; global options appear before `run`. An optional separator remains an escape hatch. Name/path ambiguity, positional task arguments and dependency arguments need a formal rule. A short CLI alias is a proposal; its spelling and collision risks remain to be decided.

Annotations may generate argument validation; unsupported types should produce clear errors. Required/default/boolean handling needs a documented contract.

## Task graph and marks

Dependencies must resolve before execution; cycles and missing references fail early, shared prerequisites execute once per invocation and failed prerequisites block dependents. Marks are named in `tasknest.toml`; filtering selects entry tasks and keeps prerequisites. Marks such as `offline` and `writes` are declarations, not enforcement. Initial execution should be sequential; quality checks must not be cached by default.
