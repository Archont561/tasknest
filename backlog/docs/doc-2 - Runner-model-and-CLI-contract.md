---
id: doc-2
title: Runner model and CLI contract
type: specification
created_date: '2026-11-15T00:46:00Z'
---

# Runner model and CLI contract

This document defines the **normative M1–M4 contract** for Tasknest task registration, discovery, dependency resolution, execution context, caching, parallelism, watch mode, reporting, and CLI parsing, and explicitly separates deferred proposals from accepted behavior.

> **Security notice:** Discovering tasks imports task source files and executes top-level Python or TypeScript code. Discovery is **not** a sandbox; run Tasknest only on trusted repositories.

## 1. Configuration (`tasknest.toml`)

- Configuration lives in `tasknest.toml` at the repository root (`config_version = 1`).
- Each `[[discovery.roots]]` entry defines:
  - `path`: directory relative to `repo_root` containing task files.
  - `namespace`: optional canonical dot prefix (default `""`).
  - `project_root`: directory relative to `repo_root` used as `ctx.project_root` (default `"."`).
- If no `tasknest.toml` is found when using defaults, discovery defaults to a single root (`path = "tools"`, `namespace = ""`, `project_root = "."`) only if explicitly constructed or when `tasknest.toml` is present; missing an explicitly passed `--config` fails with a configuration error (exit code `2`).

## 2. Discovery and registration

- **One task per file:** Each discovered non-underscore source file under a configured root must register **exactly one** task via `@tool(...)` (or the equivalent TS `tool(...)` factory). Registering `0` tasks or `>1` tasks in a discovered file is a discovery error.
- **Exclusions:**
  - Any file or directory whose name starts with `_` (including `_helpers.py`, `_asset/`, `__init__.py`, `__pycache__/`) is ignored during discovery.
  - Top-level `tests/` and `features/` directories directly under a discovery root are reserved support directories and are ignored during discovery.
- **Canonical names and CLI paths:**
  - Relative file path under the root (without extension) produces segments, e.g. `check/dev.py` -> segments `["check", "dev"]`.
  - Prepending non-empty `namespace` segments yields the canonical dotted name (`"check.dev"` or `"repo.check.dev"`) and space-separated CLI path (`check dev` or `repo check dev`).
  - Duplicate canonical names across roots or files fail discovery with an error.
- **Descriptions:** The task docstring (or explicit `description=` argument) supplies the summary shown in `ls` and `help`.

Illustrative Python definition:

```python
from pathlib import Path
from tasknest import ToolContext, tool

@tool(depends=["format.check", "test"], marks=["fast"], requires=["ruff"])
def lint(ctx: ToolContext, path: Path = Path("."), fix: bool = False) -> None:
    """Lint the workspace."""
    argv = ["ruff", "check", str(path)]
    if fix:
        argv.append("--fix")
    ctx.run(argv)
```

## 3. Typed task parameters

- If the first parameter is named `ctx` or annotated as `ToolContext`, Tasknest injects `ToolContext` at runtime and excludes it from CLI arguments; tasks with no `ctx` parameter are also allowed.
- Supported CLI parameter annotations:
  - `str`, `int`, `float`, `bool`, `pathlib.Path`
  - `T | None` / `Optional[T]`
  - `Literal[...]` of `str`/`int` values
  - `list[T]` (repeatable option, e.g. `--tag a --tag b`)
- Unsupported parameter types, `*args`, or `**kwargs` fail validation during `check`/`plan`/`run` with a clear error naming the task and parameter.
- Parameter `dry_run` maps to `--dry-run` (hyphens in CLI flags).
- `bool` parameters accept `--flag` (sets `True`) and `--no-flag` (sets `False`); parameters without defaults are required.

## 4. CLI grammar and ambiguity resolution

```text
tasknest [GLOBAL OPTIONS] <command> [ARGS...]
```

- **Global options** (`--root <path>`, `--config <path>`, `--verbose`, `--help`, `--version`) are parsed **only before** the subcommand so they never collide with task options.
- **Subcommands:**
  - `ls` — list discovered tasks (`CLI path`, `canonical name`, summary).
  - `help [task path...]` — show global help, or detailed help for a task.
  - `check` — discover tasks, validate registrations, parameter types, dependencies, and cycles without executing tasks.
  - `plan <task path...>` — resolve and display the sequential execution order without executing tasks.
  - `run [RUN FLAGS] <task path...> [task options/args]` — validate, resolve dependencies, and execute tasks (with optional `--jobs`/`-j <n>`, `--fail-fast`, `--force`, `--no-cache`, `--json`, `--report <path>`, `--changed-base <ref>`, `--changed <path>`, `--all`, `--mark <name>`).
  - `watch [WATCH FLAGS] <task path...>` — monitor declared `inputs` across the resolved DAG (ignoring own declared `outputs`) and re-run only the minimal dirty subgraph (`--interval <ms>`, `--max-cycles <n>`, `--jobs`/`-j <n>`, `--json`).
  - `skill` — check (`--check`) or write (`--write`, `--force`) generated agent `SKILL.md`.
- **Task-path resolution and positional conflict rule:**
  - Task options do **not** require a `--` separator before them (`tasknest run lint --path src --fix`).
  - Non-flag tokens after `help` / `plan` / `run` up to the first `-`/`--` option or `--` separator are matched by **longest registered task-path prefix** (a single canonical dotted token such as `check.dev` is also accepted).
  - If `--` appears after the task-path tokens (e.g. `tasknest run lint -- src/app.py`), `--` explicitly ends task-path matching and forwards remaining tokens as positional task arguments.
  - If a registered task `a` accepts positional arguments and another registered task `a.b` shares the prefix `a`, invoking `tasknest run a b` resolves `a.b` (longest match), while `tasknest run a -- b` passes `b` positionally to `a`.
- **Exit codes:** `0` success, `1` task execution/runtime failure, `2` CLI usage, configuration, discovery, validation, or dependency graph error.

## 5. Dependency graph and sequential execution

- `depends` accepts decorated task references or canonical dotted strings (`"format.check"`).
- All dependency references and cycles are validated **before** any task executes (`check`, `plan`, and `run`).
  - Missing dependency example: `Unknown dependency 'missing.task' required by 'build'`.
  - Cycle example: `Dependency cycle detected: a -> b -> a`.
- Tasks execute sequentially (`jobs = 1`) in topological order preserving declaration order.
- Each shared prerequisite executes **at most once** per invocation.
- If a prerequisite fails (`ToolError` or unhandled exception), execution stops along dependent branches, reports the failed task and all downstream **blocked** tasks, and exits with code `1`.

## 6. Execution context (`ToolContext`), data passing, caching, and reporting (M4)

- `ToolContext` exposes `repo_root`, `project_root`, `task_name`, `verbose`, `deps`, `affected`, `run(...)`, `output(...)`, and task-local environment helpers (`env`, `set_env`/`setEnv`, `unset_env`/`unsetEnv`, `scoped_env`/`withEnv`).
- `ctx.run(argv, *, cwd=None, env=None, timeout=None, check=True, capture=False) -> CommandResult`:
  - Accepts an explicit `argv` sequence and executes **without a shell** (`shell=False`). Passing a raw string raises `ToolError`.
  - Defaults `cwd` to `ctx.project_root` when omitted.
  - Merges `env` overrides on top of the task-local environment without mutating global `os.environ` or `process.env`.
  - Raises `ToolError` on nonzero exit (`check=True`), timeout, or missing executable.
- `ctx.output(value, ...)` validates immediately (JSON default across `tasknest-py` and `tasknest-ts`; opt-in local-only `pickle` in Python) and commits on task success; downstream tasks read declared dependency outputs via read-only `ctx.deps["<canonical>"]`.
- Opt-in caching (`cache=True` with declared `inputs`, `outputs`, `env`) stores content-hashed entries under `.tasknest/cache/` (`schema_version = 1`), bypasses on `--force`/`--no-cache`, invalidates on missing/modified declared `outputs`, and supports early cutoff via upstream `ctx.output` digests.
- Opt-in parallel scheduling (`--jobs N`) enforces `resources` conflict locking, bounds workers via `TASKNEST_WORKER_BUDGET`, blocks dependents of failed tasks, and cancels unstarted work on `--fail-fast`.
- `--json` emits a pure versioned JSON report (`schema_version = 1`) on stdout while routing task/subprocess stdout to stderr; `--report <path>` writes the redacted report to disk.
- `ctx.affected` exposes `AffectedContext` (`available`, `complete`, `base_ref`, `target_ref`, `reason`, `files[]` with `path`, `old_path`, `status`); git comparisons compare `base_ref` (default `HEAD`) against `WORKTREE` (with `--include-untracked` enabled by default).

## 7. Deferred / open proposals

- Short CLI alias (e.g. `tg`) — deferred.
- Strict structural policy enforcement (`[checks]` in `tasknest.toml`), mark filtering (`--mark`), and built-in ecosystem adapters — implemented in `M2`.
- Native TypeScript runner (`Bun` and `Node.js` adapters) and cross-language conformance fixtures — implemented in `M3`.
- Parallel scheduler (`jobs > 1`), affected selection (`ctx.affected` + conservative selectors), machine-readable JSON reports, `ctx.output(...)` / `ctx.deps[...]` / `ctx.env(...)`, opt-in output caching (`.tasknest/cache/`), and DAG-aware `watch` mode — implemented in `M4`.
