"""Tasknest command-line interface."""

from __future__ import annotations

import contextlib
import json
import sys
from typing import TYPE_CHECKING, Any

from tasknest import VERSION
from tasknest._cli_flags import (
    DASH,
    DOUBLE_DASH,
    GlobalOpts,
    RunCliFlags,
    parse_global_opts,
    parse_run_flags,
    parse_select_flags,
    parse_skill_flags,
    parse_task_args,
    parse_watch_flags,
)
from tasknest.affected import (
    AffectedContext,
    ChangedFile,
    collect_git_changes,
    normalize_rel_path,
)
from tasknest.discovery import TaskRegistry, discover_tasks
from tasknest.errors import CliUsageError, DiscoveryError, TasknestError
from tasknest.graph import (
    ExecutionReport,
    RunOptions,
    plan_execution,
    run_order,
    run_plan,
    validate_graph,
)
from tasknest.report import ReportMetadata, serialize_json_report, write_json_report
from tasknest.skill import check_skill, write_skill
from tasknest.validation import (
    format_effect_summary,
    matches_package,
    select_tasks_by_marks,
    select_tasks_each,
    validate_registry,
)
from tasknest.watch import WatchConfig, WatchCycle, WatchSession

if TYPE_CHECKING:
    from collections.abc import Sequence

    from tasknest.task import TaskDefinition

_SPACE = " "
_COMMA_SEP = ", "

_GLOBAL_USAGE = (
    "Usage: tasknest [--root PATH] [--config PATH] [-v|--verbose] <command> [args...]\n\n"
    "Commands:\n"
    "  ls              List discovered tasks\n"
    "  help [task...]  Show global help or task details\n"
    "  check           Validate discovery, parameters, marks, and dependency graph\n"
    "  plan <task...>  Show sequential execution order\n"
    "  run <task...>   Execute a task and its dependencies\n"
    "  watch <task...> Watch declared inputs and re-run dirty subgraph\n"
    "  skill           Check or write generated agent SKILL.md\n"
)


def _split_task_tokens(
    tokens: Sequence[str],
    registry: TaskRegistry,
    packages: Sequence[str] = (),
) -> tuple[TaskDefinition, list[str]]:
    if DOUBLE_DASH in tokens:
        sep = tokens.index(DOUBLE_DASH)
        head, tail = list(tokens[:sep]), list(tokens[sep + 1 :])
    else:
        head, tail = list(tokens), []
    path_end = 0
    for tok in head:
        if tok.startswith(DASH):
            break
        path_end += 1
    if path_end == 0:
        raise CliUsageError("Expected a task path.")
    path_tokens = head[:path_end]
    rest_head = head[path_end:]
    if len(packages) == 1 and path_tokens[0] != packages[0] and "." not in path_tokens[0]:
        scoped = [*packages[0].split("."), *path_tokens]
        with contextlib.suppress(DiscoveryError):
            task, extra_pos = registry.resolve_path(scoped)
            return task, [*extra_pos, *rest_head, *tail]
    try:
        task, extra_pos = registry.resolve_path(path_tokens)
    except DiscoveryError as exc:
        raise CliUsageError(str(exc)) from exc
    if packages and not matches_package(task, packages):
        pkg_list = _COMMA_SEP.join(packages)
        raise CliUsageError(f"Task '{task.name}' is not in selected package(s): {pkg_list}.")
    return task, [*extra_pos, *rest_head, *tail]


def _format_task_help(task: TaskDefinition) -> str:
    lines = [f"Task: {_SPACE.join(task.cli_path)} ({task.name})"]
    if task.description:
        lines.append(f"  {task.description}")
    deps = _COMMA_SEP.join(d if isinstance(d, str) else d.name for d in task.depends)
    metadata = (
        ("depends", deps),
        ("marks", _COMMA_SEP.join(task.marks)),
        ("requires", _COMMA_SEP.join(task.requires)),
        ("inputs", _COMMA_SEP.join(task.inputs)),
        ("outputs", _COMMA_SEP.join(task.outputs)),
        ("persistent", "true" if task.persistent else ""),
    )
    lines.extend(f"  {label}: {val}" for label, val in metadata if val)
    if task.options:
        lines.append("  options:")
        for opt in task.options:
            status = "required" if opt.required else f"default={opt.default!r}"
            lines.append(f"    --{opt.cli_name} <{opt.format_type()}> ({status})")
    return "\n".join(lines)


def _print_effects(registry: TaskRegistry, names: Sequence[str]) -> None:
    for line in format_effect_summary(registry, names):
        print(f"effect: {line}")


def _cmd_ls(registry: TaskRegistry, rest: Sequence[str]) -> int:
    sel, extra = parse_select_flags(rest, allow_each=False)
    if extra:
        raise CliUsageError("ls accepts only --mark <name> and --package <name> options.")
    for task in registry.ordered_tasks():
        if sel.marks and not any(m in task.marks for m in sel.marks):
            continue
        if sel.packages and not matches_package(task, sel.packages):
            continue
        summary = task.description.splitlines()[0] if task.description else ""
        path = _SPACE.join(task.cli_path)
        mark_suffix = f" [marks: {_COMMA_SEP.join(task.marks)}]" if task.marks else ""
        persistent_suffix = " [persistent]" if task.persistent else ""
        base = f"{path} ({task.name}){mark_suffix}{persistent_suffix}"
        print(f"{base} - {summary}" if summary else base)
    return 0


def _cmd_help(registry: TaskRegistry, rest: Sequence[str]) -> int:
    if not rest:
        print(_GLOBAL_USAGE, end="")
        return 0
    task, extra = _split_task_tokens(rest, registry)
    if extra:
        raise CliUsageError(f"Unexpected arguments to help: {_SPACE.join(extra)}")
    print(_format_task_help(task))
    return 0


def _cmd_check(registry: TaskRegistry, rest: Sequence[str]) -> int:
    if rest:
        raise CliUsageError("check does not take positional arguments.")
    val_result = validate_registry(registry)
    for warning in val_result.warnings:
        print(f"warning: {warning}", file=sys.stderr)
    validate_graph(registry)
    print(f"OK ({len(registry.tasks)} task(s) validated)")
    return 0


def _cmd_plan(registry: TaskRegistry, rest: Sequence[str]) -> int:
    sel, remaining = parse_select_flags(rest)
    if sel.marks and sel.each:
        raise CliUsageError("plan --mark cannot be combined with --each.")
    if sel.each:
        if remaining:
            raise CliUsageError("plan --each cannot be combined with a task path.")
        order = select_tasks_each(registry, sel.each, packages=sel.packages)
    elif sel.marks:
        if remaining:
            raise CliUsageError("plan --mark cannot be combined with a task path.")
        order = select_tasks_by_marks(registry, sel.marks, packages=sel.packages)
    else:
        task, extra = _split_task_tokens(remaining, registry, sel.packages)
        if extra:
            raise CliUsageError(f"Unexpected arguments to plan: {_SPACE.join(extra)}")
        order = plan_execution(registry, task.name)
    for index, name in enumerate(order, start=1):
        print(f"{index}. {name}")
    _print_effects(registry, order)
    return 0


def _resolve_affected_context(registry: TaskRegistry, flags: RunCliFlags) -> AffectedContext:
    if flags.changed_paths:
        files = tuple(
            ChangedFile(path=normalize_rel_path(p), status="modified") for p in flags.changed_paths
        )
        return AffectedContext(
            available=True,
            complete=True,
            files=files,
            base_ref=flags.changed_base,
            target_ref="CLI",
            reason=None,
        )
    if flags.changed_base is not None:
        return collect_git_changes(registry.config.repo_root, base_ref=flags.changed_base)
    return AffectedContext()


def _emit_run_outputs(
    report: ExecutionReport,
    flags: RunCliFlags,
    target: str | None,
    affected: AffectedContext,
) -> int:
    meta = ReportMetadata(
        target=target,
        jobs=report.jobs,
        started_at=report.started_at,
        duration_ms=report.duration_ms,
        exit_code=report.exit_code,
        affected=affected if affected.available else None,
    )
    if flags.report_path is not None:
        write_json_report(flags.report_path, report.task_records, meta)
    if flags.json_output:
        print(serialize_json_report(report.task_records, meta))
        return int(report.exit_code)
    if report.failed:
        for failed_name in report.failed:
            print(f"FAILED {failed_name}: {report.errors[failed_name]}", file=sys.stderr)
        if report.blocked:
            print(f"BLOCKED: {_COMMA_SEP.join(report.blocked)}", file=sys.stderr)
    return int(report.exit_code)


def _run_selected_order(
    registry: TaskRegistry,
    order: tuple[str, ...],
    flags: RunCliFlags,
    opts: RunOptions,
    affected: AffectedContext,
) -> int:
    if not flags.json_output:
        _print_effects(registry, order)
    redirect = (
        contextlib.redirect_stdout(sys.stderr) if flags.json_output else contextlib.nullcontext()
    )
    with redirect:
        report = run_order(registry, order, options=opts)
    return _emit_run_outputs(report, flags, None, affected)


def _cmd_run(registry: TaskRegistry, rest: Sequence[str], *, is_verbose: bool) -> int:
    flags, remaining = parse_run_flags(rest)
    affected = _resolve_affected_context(registry, flags)
    opts = RunOptions(
        jobs=flags.jobs,
        cache_mode=flags.cache_mode,
        is_verbose=is_verbose,
        fail_fast=flags.fail_fast,
        affected=affected,
        quiet_stdout=flags.json_output,
    )
    if flags.marks and flags.each:
        raise CliUsageError("run --mark cannot be combined with --each.")
    if flags.each:
        if remaining:
            raise CliUsageError("run --each cannot be combined with a task path.")
        order = select_tasks_each(registry, flags.each, packages=flags.packages)
        return _run_selected_order(registry, order, flags, opts, affected)
    if flags.marks:
        if remaining:
            raise CliUsageError("run --mark cannot be combined with a task path.")
        order = select_tasks_by_marks(registry, flags.marks, packages=flags.packages)
        return _run_selected_order(registry, order, flags, opts, affected)
    task, extra = _split_task_tokens(remaining, registry, flags.packages)
    kwargs, wants_help = parse_task_args(task, extra)
    if wants_help:
        print(_format_task_help(task))
        return 0
    redirect = (
        contextlib.redirect_stdout(sys.stderr) if flags.json_output else contextlib.nullcontext()
    )
    with redirect:
        report = run_plan(registry, task.name, kwargs, options=opts)
    return _emit_run_outputs(report, flags, task.name, affected)


def _format_watch_cycle(cycle: WatchCycle, *, as_json: bool) -> None:
    if as_json:
        payload = {
            "cycle": cycle.cycle_index,
            "dirty_tasks": list(cycle.dirty_tasks),
            "skipped_clean": list(cycle.skipped_clean),
            "succeeded": list(cycle.report.succeeded),
            "skipped_cached": list(cycle.report.skipped),
            "failed": list(cycle.report.failed),
            "exit_code": cycle.report.exit_code,
        }
        print(json.dumps(payload), flush=True)
        return
    dirty = _COMMA_SEP.join(cycle.dirty_tasks)
    cached = _COMMA_SEP.join(cycle.report.skipped) or "none"
    clean = _COMMA_SEP.join(cycle.skipped_clean) or "none"
    print(f"[watch #{cycle.cycle_index}] dirty={dirty} cached={cached} clean={clean}", flush=True)


def _cmd_watch(registry: TaskRegistry, rest: Sequence[str], *, is_verbose: bool) -> int:
    flags, remaining = parse_watch_flags(rest)
    task, extra = _split_task_tokens(remaining, registry)
    kwargs, wants_help = parse_task_args(task, extra)
    if wants_help:
        print(_format_task_help(task))
        return 0
    cfg = WatchConfig(
        interval_ms=flags.interval_ms,
        max_cycles=flags.max_cycles,
        jobs=flags.jobs,
        is_verbose=is_verbose,
    )
    session = WatchSession(
        registry=registry, target_name=task.name, target_kwargs=kwargs, config=cfg
    )
    cycles = session.run(on_cycle=lambda c: _format_watch_cycle(c, as_json=flags.json_output))
    return cycles[-1].report.exit_code if cycles else 0


def _cmd_skill(registry: TaskRegistry, rest: Sequence[str]) -> int:
    write_mode, force, output_path, template_path = parse_skill_flags(rest)
    if write_mode:
        target = write_skill(
            registry, output_path=output_path, template_path=template_path, force=force
        )
        print(f"WROTE {target}")
        return 0
    ok = check_skill(registry, output_path=output_path, template_path=template_path)
    if not ok:
        print("DRIFT skill output is missing or out of date", file=sys.stderr)
        return 1
    print("OK skill is up to date")
    return 0


def _dispatch(opts: GlobalOpts) -> int:
    if opts.show_version:
        print(f"tasknest {VERSION}")
        return 0
    if opts.show_help or not opts.rest:
        print(_GLOBAL_USAGE, end="")
        return 0
    cmd, rest = opts.rest[0], opts.rest[1:]
    if cmd == "help" and not rest:
        print(_GLOBAL_USAGE, end="")
        return 0
    registry = discover_tasks(opts.root, config_path=opts.config)
    handlers: dict[str, Any] = {
        "ls": _cmd_ls,
        "help": _cmd_help,
        "check": _cmd_check,
        "plan": _cmd_plan,
        "skill": _cmd_skill,
        "run": lambda reg, args: _cmd_run(reg, args, is_verbose=opts.verbose),
        "watch": lambda reg, args: _cmd_watch(reg, args, is_verbose=opts.verbose),
    }
    handler = handlers.get(cmd)
    if handler is None:
        raise CliUsageError(f"Unknown command: {cmd}")
    return int(handler(registry, rest))


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entrypoint returning an OS exit code."""
    raw = list(sys.argv[1:] if argv is None else argv)
    try:
        opts = parse_global_opts(raw)
        return _dispatch(opts)
    except TasknestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.exit_code
