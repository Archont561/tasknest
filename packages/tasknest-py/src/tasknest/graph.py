"""Dependency graph validation and sequential execution."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from tasknest.context import ToolContext
from tasknest.errors import GraphError, ToolError

if TYPE_CHECKING:
    from tasknest.discovery import TaskRegistry
    from tasknest.task import TaskDefinition


@dataclass(frozen=True)
class ExecutionReport:
    """Summary of a sequential task invocation."""

    succeeded: tuple[str, ...]
    failed: tuple[str, ...]
    blocked: tuple[str, ...]
    errors: dict[str, str]
    exit_code: int = 0


@dataclass
class _RunState:
    succeeded: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    blocked: list[str] = field(default_factory=list)
    errors: dict[str, str] = field(default_factory=dict)
    unmet: set[str] = field(default_factory=set)
    exit_code: int = 0


def _resolve_dep_name(
    task: TaskDefinition, dep: str | TaskDefinition, registry: TaskRegistry
) -> str:
    if isinstance(dep, str):
        if dep not in registry.tasks:
            raise GraphError(f"Unknown dependency {dep!r} required by {task.name!r}.")
        return dep
    for name, candidate in registry.tasks.items():
        if candidate == dep:
            return name
    raise GraphError(f"Unregistered dependency {dep.name!r} required by {task.name!r}.")


def validate_graph(registry: TaskRegistry) -> dict[str, tuple[str, ...]]:
    """Resolve all dependency references and detect cycles across the registry."""
    resolved: dict[str, tuple[str, ...]] = {}
    for name, task in registry.tasks.items():
        resolved[name] = tuple(_resolve_dep_name(task, dep, registry) for dep in task.depends)
    state: dict[str, int] = {}

    def visit(node: str, trail: list[str]) -> None:
        mark = state.get(node, 0)
        if mark == 2:
            return
        if mark == 1:
            start = trail.index(node)
            cycle = " -> ".join([*trail[start:], node])
            raise GraphError(f"Dependency cycle detected: {cycle}")
        state[node] = 1
        for dep_name in resolved[node]:
            visit(dep_name, [*trail, node])
        state[node] = 2

    for name in sorted(resolved):
        visit(name, [])
    return resolved


def _collect_order(deps_map: dict[str, tuple[str, ...]], target_name: str) -> tuple[str, ...]:
    order: list[str] = []
    seen: set[str] = set()

    def collect(name: str) -> None:
        if name in seen:
            return
        seen.add(name)
        for dep_name in deps_map[name]:
            collect(dep_name)
        order.append(name)

    collect(target_name)
    return tuple(order)


def plan_execution(registry: TaskRegistry, target_name: str) -> tuple[str, ...]:
    """Return sequential topological execution order for target_name."""
    deps_map = validate_graph(registry)
    return _collect_order(deps_map, target_name)


def _invoke_task(
    task: TaskDefinition,
    registry: TaskRegistry,
    kwargs: dict[str, Any],
    *,
    is_verbose: bool = False,
) -> None:
    proj_root = task.project_root or registry.config.repo_root
    ctx = ToolContext(
        repo_root=registry.config.repo_root,
        project_root=proj_root,
        task_name=task.name,
        verbose=is_verbose,
    )
    if task.takes_context:
        task.callable_fn(ctx, **kwargs)
    else:
        task.callable_fn(**kwargs)


def _step_task(
    name: str,
    registry: TaskRegistry,
    kwargs: dict[str, Any],
    state: _RunState,
    *,
    is_verbose: bool = False,
) -> None:
    try:
        _invoke_task(registry.tasks[name], registry, kwargs, is_verbose=is_verbose)
    except ToolError as exc:
        state.failed.append(name)
        state.unmet.add(name)
        state.errors[name] = str(exc)
        state.exit_code = state.exit_code or exc.exit_code or 1
    except Exception as exc:
        state.failed.append(name)
        state.unmet.add(name)
        state.errors[name] = str(exc)
        state.exit_code = state.exit_code or 1
    else:
        state.succeeded.append(name)


def run_order(
    registry: TaskRegistry,
    order: tuple[str, ...],
    *,
    is_verbose: bool = False,
) -> ExecutionReport:
    """Execute a pre-resolved task order sequentially; failures block dependents."""
    deps_map = validate_graph(registry)
    state = _RunState()
    for name in order:
        if any(dep in state.unmet for dep in deps_map[name]):
            state.blocked.append(name)
            state.unmet.add(name)
            continue
        _step_task(name, registry, {}, state, is_verbose=is_verbose)
    return ExecutionReport(
        succeeded=tuple(state.succeeded),
        failed=tuple(state.failed),
        blocked=tuple(state.blocked),
        errors=state.errors,
        exit_code=state.exit_code,
    )


def run_plan(
    registry: TaskRegistry,
    target_name: str,
    target_kwargs: dict[str, Any],
    *,
    is_verbose: bool = False,
) -> ExecutionReport:
    """Execute planned tasks sequentially; failures block dependents."""
    deps_map = validate_graph(registry)
    order = _collect_order(deps_map, target_name)
    state = _RunState()
    for name in order:
        if any(dep in state.unmet for dep in deps_map[name]):
            state.blocked.append(name)
            state.unmet.add(name)
            continue
        kwargs = target_kwargs if name == target_name else {}
        _step_task(name, registry, kwargs, state, is_verbose=is_verbose)
    return ExecutionReport(
        succeeded=tuple(state.succeeded),
        failed=tuple(state.failed),
        blocked=tuple(state.blocked),
        errors=state.errors,
        exit_code=state.exit_code,
    )
