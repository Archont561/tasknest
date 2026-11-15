"""Dependency graph validation and sequential/parallel execution with caching."""

from __future__ import annotations

import os
import time
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from datetime import datetime, timezone
from threading import Event, Lock
from typing import TYPE_CHECKING, Any

from tasknest._process import install_interrupt_handlers, resolve_persistent_workers
from tasknest.affected import AffectedContext
from tasknest.cache import CacheContext, CacheMode, lookup_cache, store_cache
from tasknest.context import BufferedOutput, DepsMapping, ToolContext
from tasknest.errors import GraphError, ToolError
from tasknest.report import TaskRunRecord

if TYPE_CHECKING:
    from collections.abc import Mapping

    from tasknest.discovery import TaskRegistry
    from tasknest.task import TaskDefinition

_MS_PER_SEC = 1000.0


@dataclass(frozen=True)
class RunOptions:
    """Execution options for run_order and run_plan."""

    jobs: int | None = None
    cache_mode: CacheMode = "default"
    is_verbose: bool = False
    fail_fast: bool = False
    affected: AffectedContext | None = None
    selection_reasons: Mapping[str, str] | None = None
    seed_outputs: Mapping[str, Any] = field(default_factory=dict)
    seed_output_hashes: Mapping[str, str] = field(default_factory=dict)
    target_name: str | None = None
    target_kwargs: Mapping[str, Any] = field(default_factory=dict)
    quiet_stdout: bool = False
    cancel_event: Event | None = None


@dataclass(frozen=True)
class ExecutionReport:
    """Summary of a sequential or parallel task invocation."""

    succeeded: tuple[str, ...]
    failed: tuple[str, ...]
    blocked: tuple[str, ...]
    errors: dict[str, str]
    exit_code: int = 0
    skipped: tuple[str, ...] = ()
    cancelled: tuple[str, ...] = ()
    task_records: tuple[TaskRunRecord, ...] = ()
    committed_outputs: dict[str, Any] = field(default_factory=dict)
    output_hashes: dict[str, str] = field(default_factory=dict)
    started_at: str = ""
    duration_ms: float = 0.0
    jobs: int = 1


@dataclass
class _TaskOutcome:
    name: str
    record: TaskRunRecord
    output: BufferedOutput | None = None
    error_message: str | None = None
    exit_code: int = 0
    cancelled: bool = False


@dataclass
class _RunState:
    succeeded: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    blocked: list[str] = field(default_factory=list)
    cancelled: list[str] = field(default_factory=list)
    errors: dict[str, str] = field(default_factory=dict)
    records: dict[str, TaskRunRecord] = field(default_factory=dict)
    unmet: set[str] = field(default_factory=set)
    done: set[str] = field(default_factory=set)
    committed_outputs: dict[str, Any] = field(default_factory=dict)
    output_hashes: dict[str, str] = field(default_factory=dict)
    exit_code: int = 0
    lock: Lock = field(default_factory=Lock)


@dataclass(frozen=True)
class _ExecEnv:
    registry: TaskRegistry
    deps_map: dict[str, tuple[str, ...]]
    state: _RunState
    opts: RunOptions
    base_env: Mapping[str, str]
    target_name: str | None
    target_kwargs: dict[str, Any]
    cancel_event: Event
    has_persistent: bool = False


def compute_worker_budget(requested_jobs: int, task_count: int) -> int:
    """Bound worker count against nested TASKNEST_WORKER_BUDGET and task count."""
    bounded = max(1, requested_jobs)
    env_cap = os.environ.get("TASKNEST_WORKER_BUDGET")
    if env_cap and env_cap.isdigit():
        bounded = min(bounded, max(1, int(env_cap)))
    return max(1, min(bounded, max(1, task_count)))


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
    resolved = {
        name: tuple(_resolve_dep_name(task, dep, registry) for dep in task.depends)
        for name, task in registry.tasks.items()
    }
    state: dict[str, int] = {}

    def visit(node: str, trail: list[str]) -> None:
        mark = state.get(node, 0)
        if mark == 2:
            return
        if mark == 1:
            start = trail.index(node)
            raise GraphError(f"Dependency cycle detected: {' -> '.join([*trail[start:], node])}")
        state[node] = 1
        for dep_name in resolved[node]:
            visit(dep_name, [*trail, node])
        state[node] = 2

    for name in sorted(resolved):
        visit(name, [])
    for name, deps in resolved.items():
        for dep_name in deps:
            if registry.tasks[dep_name].persistent:
                raise GraphError(f"Task {name!r} cannot depend on persistent task {dep_name!r}.")
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
    return _collect_order(validate_graph(registry), target_name)


def _build_task_context(task: TaskDefinition, env: _ExecEnv) -> tuple[ToolContext, dict[str, str]]:
    proj_root = task.project_root or env.registry.config.repo_root
    allowed = frozenset(_resolve_dep_name(task, d, env.registry) for d in task.depends)
    with env.state.lock:
        dep_vals = dict(env.state.committed_outputs)
        dep_hashes = {
            d: env.state.output_hashes[d] for d in allowed if d in env.state.output_hashes
        }
    prefix = f"[{task.name}] " if (env.has_persistent and not env.opts.quiet_stdout) else None
    ctx = ToolContext(
        repo_root=env.registry.config.repo_root,
        project_root=proj_root,
        task_name=task.name,
        verbose=env.opts.is_verbose,
        base_env=env.base_env,
        deps=DepsMapping(task.name, allowed, dep_vals),
        affected=env.opts.affected or AffectedContext(),
        quiet_stdout=env.opts.quiet_stdout,
        cancel_event=env.cancel_event,
        line_prefix=prefix,
    )
    return ctx, dep_hashes


def _failure_outcome(
    task: TaskDefinition,
    ctx: ToolContext,
    elapsed: float,
    error_text: str,
    code: int,
) -> tuple[TaskRunRecord, BufferedOutput | None, str | None, int, bool]:
    cancelled = ctx.is_cancelled
    rec = TaskRunRecord(
        name=task.name,
        status="cancelled" if cancelled else "failed",
        cache_status="miss" if task.cache else "disabled",
        duration_ms=elapsed,
        commands=ctx.recorded_commands(),
        error=error_text,
    )
    if cancelled:
        return rec, None, None, code or 130, True
    return rec, None, error_text, code or 1, False


def _run_callable_and_record(
    task: TaskDefinition,
    ctx: ToolContext,
    kwargs: dict[str, Any],
    cache_ctx: CacheContext,
    started: float,
) -> tuple[TaskRunRecord, BufferedOutput | None, str | None, int, bool]:
    try:
        if task.takes_context:
            task.callable_fn(ctx, **kwargs)
        else:
            task.callable_fn(**kwargs)
    except ToolError as exc:
        elapsed = (time.perf_counter() - started) * _MS_PER_SEC
        return _failure_outcome(task, ctx, elapsed, str(exc), exc.exit_code)
    except Exception as exc:
        elapsed = (time.perf_counter() - started) * _MS_PER_SEC
        return _failure_outcome(task, ctx, elapsed, str(exc), 1)
    pending = ctx.consume_pending_output()
    store_cache(cache_ctx, ctx.accessed_env_snapshot(), pending)
    elapsed = (time.perf_counter() - started) * _MS_PER_SEC
    rec = TaskRunRecord(
        name=task.name,
        status="passed",
        duration_ms=elapsed,
        commands=ctx.recorded_commands(),
        output_hash=pending.digest if pending else None,
    )
    return rec, pending, None, 0, False


def _execute_single_task(name: str, env: _ExecEnv) -> _TaskOutcome:
    started = time.perf_counter()
    task = env.registry.tasks[name]
    kwargs = env.target_kwargs if name == env.target_name else {}
    ctx, dep_hashes = _build_task_context(task, env)
    sel_reason = env.opts.selection_reasons.get(name) if env.opts.selection_reasons else None
    cache_ctx = CacheContext(
        repo_root=env.registry.config.repo_root,
        project_root=ctx.project_root,
        task=task,
        kwargs=kwargs,
        dep_hashes=dep_hashes,
        base_env=env.base_env,
        mode=env.opts.cache_mode,
    )
    lookup = lookup_cache(cache_ctx)
    if lookup.status == "hit":
        rec = TaskRunRecord(
            name=name,
            status="skipped",
            cache_status="hit",
            cache_reason=lookup.reason,
            duration_ms=(time.perf_counter() - started) * _MS_PER_SEC,
            output_hash=lookup.output.digest if lookup.output else None,
            selection_reason=sel_reason,
        )
        return _TaskOutcome(name=name, record=rec, output=lookup.output)
    raw_rec, pending, err, code, is_cancelled = _run_callable_and_record(
        task, ctx, kwargs, cache_ctx, started
    )
    rec = TaskRunRecord(
        name=raw_rec.name,
        status=raw_rec.status,
        cache_status=lookup.status,
        cache_reason=lookup.reason,
        duration_ms=raw_rec.duration_ms,
        commands=raw_rec.commands,
        error=raw_rec.error,
        output_hash=raw_rec.output_hash,
        selection_reason=sel_reason,
    )
    return _TaskOutcome(
        name=name,
        record=rec,
        output=pending,
        error_message=err,
        exit_code=code,
        cancelled=is_cancelled,
    )


def _record_outcome(outcome: _TaskOutcome, env: _ExecEnv) -> None:
    state = env.state
    with state.lock:
        state.records[outcome.name] = outcome.record
        if outcome.cancelled:
            state.cancelled.append(outcome.name)
            state.unmet.add(outcome.name)
            return
        if outcome.error_message is not None:
            state.failed.append(outcome.name)
            state.unmet.add(outcome.name)
            state.errors[outcome.name] = outcome.error_message
            state.exit_code = state.exit_code or outcome.exit_code
            if env.has_persistent or env.opts.fail_fast:
                env.cancel_event.set()
            return
        state.done.add(outcome.name)
        target_list = state.skipped if outcome.record.status == "skipped" else state.succeeded
        target_list.append(outcome.name)
        if outcome.output is not None:
            state.committed_outputs[outcome.name] = outcome.output.payload
            state.output_hashes[outcome.name] = outcome.output.digest


def _mark_blocked_or_cancelled(name: str, env: _ExecEnv) -> bool:
    sel_reason = env.opts.selection_reasons.get(name) if env.opts.selection_reasons else None
    if any(dep in env.state.unmet for dep in env.deps_map[name]):
        env.state.blocked.append(name)
        env.state.unmet.add(name)
        env.state.records[name] = TaskRunRecord(
            name=name, status="blocked", selection_reason=sel_reason
        )
        return True
    if env.cancel_event.is_set() or (env.opts.fail_fast and env.state.failed):
        env.state.cancelled.append(name)
        env.state.unmet.add(name)
        env.state.records[name] = TaskRunRecord(
            name=name, status="cancelled", selection_reason=sel_reason
        )
        return True
    return False


def _run_sequential(order: tuple[str, ...], env: _ExecEnv) -> None:
    for name in order:
        if _mark_blocked_or_cancelled(name, env):
            continue
        _record_outcome(_execute_single_task(name, env), env)


def _drain_blocked(pending: list[str], env: _ExecEnv) -> None:
    progressed = True
    while progressed:
        progressed = False
        for name in list(pending):
            if _mark_blocked_or_cancelled(name, env):
                pending.remove(name)
                progressed = True


def _run_parallel(order: tuple[str, ...], env: _ExecEnv, workers: int) -> None:
    pending = list(order)
    active_resources: set[str] = set()
    in_flight: dict[Future[_TaskOutcome], str] = {}
    with ThreadPoolExecutor(max_workers=workers) as pool:
        while pending or in_flight:
            _drain_blocked(pending, env)
            for name in list(pending):
                if len(in_flight) >= workers:
                    break
                res = env.registry.tasks[name].resources
                deps_ready = all(d in env.state.done for d in env.deps_map[name])
                if deps_ready and not any(r in active_resources for r in res):
                    pending.remove(name)
                    active_resources.update(res)
                    in_flight[pool.submit(_execute_single_task, name, env)] = name
            if not in_flight:
                break
            done_futs, _ = wait(in_flight.keys(), return_when=FIRST_COMPLETED)
            for fut in done_futs:
                done_name = in_flight.pop(fut)
                active_resources.difference_update(env.registry.tasks[done_name].resources)
                _record_outcome(fut.result(), env)


def _execute_order_internal(
    registry: TaskRegistry,
    order: tuple[str, ...],
    deps_map: dict[str, tuple[str, ...]],
    target_info: tuple[str | None, dict[str, Any]],
    opts: RunOptions,
) -> ExecutionReport:
    started_iso = datetime.now(timezone.utc).isoformat()
    started_perf = time.perf_counter()
    persistent_count = sum(1 for name in order if registry.tasks[name].persistent)
    base_workers = compute_worker_budget(
        opts.jobs if opts.jobs is not None else registry.config.jobs, len(order)
    )
    workers = resolve_persistent_workers(opts.jobs, base_workers, persistent_count)
    order_set = set(order)
    state = _RunState(
        done={name for name in deps_map if name not in order_set},
        committed_outputs=dict(opts.seed_outputs),
        output_hashes=dict(opts.seed_output_hashes),
    )
    t_name, t_kwargs = (
        target_info if target_info[0] is not None else (opts.target_name, dict(opts.target_kwargs))
    )
    cancel_event = opts.cancel_event or Event()
    env = _ExecEnv(
        registry=registry,
        deps_map=deps_map,
        state=state,
        opts=opts,
        base_env={"TASKNEST_WORKER_BUDGET": "1"} if workers > 1 else {},
        target_name=t_name,
        target_kwargs=t_kwargs,
        cancel_event=cancel_event,
        has_persistent=persistent_count > 0,
    )
    with install_interrupt_handlers(cancel_event, persistent_count > 0) as signal_exit:
        if workers <= 1:
            _run_sequential(order, env)
        else:
            _run_parallel(order, env, workers)
    if signal_exit[0] is not None and state.exit_code == 0:
        state.exit_code = signal_exit[0]
    records = tuple(state.records[name] for name in order if name in state.records)
    return ExecutionReport(
        succeeded=tuple(state.succeeded),
        failed=tuple(state.failed),
        blocked=tuple(state.blocked),
        errors=state.errors,
        exit_code=state.exit_code,
        skipped=tuple(state.skipped),
        cancelled=tuple(state.cancelled),
        task_records=records,
        committed_outputs=dict(state.committed_outputs),
        output_hashes=dict(state.output_hashes),
        started_at=started_iso,
        duration_ms=(time.perf_counter() - started_perf) * _MS_PER_SEC,
        jobs=workers,
    )


def run_order(
    registry: TaskRegistry,
    order: tuple[str, ...],
    *,
    is_verbose: bool = False,
    options: RunOptions | None = None,
) -> ExecutionReport:
    """Execute a pre-resolved task order sequentially or in parallel."""
    deps_map = validate_graph(registry)
    opts = options or RunOptions(is_verbose=is_verbose)
    return _execute_order_internal(registry, order, deps_map, (None, {}), opts)


def run_plan(
    registry: TaskRegistry,
    target_name: str,
    target_kwargs: dict[str, Any],
    *,
    is_verbose: bool = False,
    options: RunOptions | None = None,
) -> ExecutionReport:
    """Execute planned tasks sequentially or in parallel; failures block dependents."""
    deps_map = validate_graph(registry)
    order = _collect_order(deps_map, target_name)
    opts = options or RunOptions(is_verbose=is_verbose)
    return _execute_order_internal(registry, order, deps_map, (target_name, target_kwargs), opts)
