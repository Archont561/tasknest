"""Tasknest command-line interface."""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from tasknest import VERSION
from tasknest.discovery import TaskRegistry, discover_tasks
from tasknest.errors import CliUsageError, DiscoveryError, TasknestError
from tasknest.graph import plan_execution, run_plan, validate_graph
from tasknest.task import TaskDefinition, TaskOption, coerce_option_value

if TYPE_CHECKING:
    from collections.abc import Sequence

_SPACE = " "
_COMMA_SEP = ", "
_DASH = "-"
_DOUBLE_DASH = "--"
_NO_PREFIX = "no-"
_PAIR_STEP = 2
_NEG_PREFIX_LEN = 3

_GLOBAL_USAGE = (
    "Usage: tasknest [--root PATH] [--config PATH] [-v|--verbose] <command> [args...]\n\n"
    "Commands:\n"
    "  ls              List discovered tasks\n"
    "  help [task...]  Show global help or task details\n"
    "  check           Validate discovery, parameters, and dependency graph\n"
    "  plan <task...>  Show sequential execution order\n"
    "  run <task...>   Execute a task and its dependencies\n"
)


@dataclass(frozen=True)
class _GlobalOpts:
    root: Path
    config: Path | None
    verbose: bool
    show_help: bool
    show_version: bool
    rest: list[str]


@dataclass
class _FlagState:
    by_name: dict[str, TaskOption]
    values: dict[str, Any]


def _consume_value(tokens: Sequence[str], index: int, flag: str) -> tuple[str, int]:
    if index + 1 >= len(tokens):
        raise CliUsageError(f"Global option {flag} requires a value.")
    return tokens[index + 1], index + _PAIR_STEP


def _parse_global_opts(argv: Sequence[str]) -> _GlobalOpts:
    root = Path.cwd()
    config: Path | None = None
    verbose = show_help = show_version = False
    idx = 0
    while idx < len(argv):
        tok = argv[idx]
        if tok == "--root":
            val, idx = _consume_value(argv, idx, tok)
            root = Path(val)
        elif tok == "--config":
            val, idx = _consume_value(argv, idx, tok)
            config = Path(val)
        elif tok in ("-v", "--verbose"):
            verbose, idx = True, idx + 1
        elif tok in ("-h", "--help"):
            show_help, idx = True, idx + 1
        elif tok == "--version":
            show_version, idx = True, idx + 1
        elif tok.startswith(_DASH):
            raise CliUsageError(f"Unknown global option before command: {tok}")
        else:
            break
    return _GlobalOpts(root, config, verbose, show_help, show_version, list(argv[idx:]))


def _split_task_tokens(
    tokens: Sequence[str], registry: TaskRegistry
) -> tuple[TaskDefinition, list[str]]:
    if _DOUBLE_DASH in tokens:
        sep = tokens.index(_DOUBLE_DASH)
        head, tail = list(tokens[:sep]), list(tokens[sep + 1 :])
    else:
        head, tail = list(tokens), []
    path_end = 0
    for tok in head:
        if tok.startswith(_DASH):
            break
        path_end += 1
    if path_end == 0:
        raise CliUsageError("Expected a task path.")
    try:
        task, extra_pos = registry.resolve_path(head[:path_end])
    except DiscoveryError as exc:
        raise CliUsageError(str(exc)) from exc
    return task, [*extra_pos, *head[path_end:], *tail]


def _apply_negated_flag(flag: str, inline: str | None, state: _FlagState) -> bool:
    if not flag.startswith(_NO_PREFIX):
        return False
    base = flag[_NEG_PREFIX_LEN:]
    opt = state.by_name.get(base)
    if opt is None or opt.base_type is not bool:
        return False
    if inline is not None:
        raise CliUsageError(f"Boolean flag --{flag} does not take a value.")
    state.values[base] = False
    return True


def _read_flag_value(
    flag: str, inline: str | None, rest: Sequence[str], idx: int
) -> tuple[str, int]:
    if inline is not None:
        return inline, idx + 1
    if idx + 1 < len(rest):
        return rest[idx + 1], idx + _PAIR_STEP
    raise CliUsageError(f"Option --{flag} requires a value.")


def _apply_long_flag(
    flag: str,
    inline: str | None,
    rest: Sequence[str],
    idx: int,
    state: _FlagState,
) -> int:
    if _apply_negated_flag(flag, inline, state):
        return idx + 1
    opt = state.by_name.get(flag)
    if opt is None:
        raise CliUsageError(f"Unknown task option: --{flag}")
    if opt.base_type is bool and inline is None and not opt.is_list:
        state.values[flag] = True
        return idx + 1
    raw, next_idx = _read_flag_value(flag, inline, rest, idx)
    coerced = coerce_option_value(opt, raw)
    if opt.is_list:
        state.values.setdefault(flag, []).append(coerced)
    else:
        state.values[flag] = coerced
    return next_idx


def _parse_task_args(task: TaskDefinition, args: Sequence[str]) -> tuple[dict[str, Any], bool]:
    state = _FlagState(by_name={opt.cli_name: opt for opt in task.options}, values={})
    positionals: list[str] = []
    idx = 0
    while idx < len(args):
        tok = args[idx]
        if tok in ("-h", "--help"):
            return {}, True
        if tok == _DOUBLE_DASH:
            positionals.extend(args[idx + 1 :])
            break
        if tok.startswith(_DOUBLE_DASH):
            body = tok[len(_DOUBLE_DASH) :]
            flag, inline = body.split("=", 1) if "=" in body else (body, None)
            idx = _apply_long_flag(flag, inline, args, idx, state)
        elif tok.startswith(_DASH):
            raise CliUsageError(f"Unknown task option: {tok}")
        else:
            positionals.append(tok)
            idx += 1
    return _finalize_task_kwargs(task, state.values, positionals), False


def _finalize_task_kwargs(
    task: TaskDefinition,
    values: dict[str, Any],
    positionals: list[str],
) -> dict[str, Any]:
    remaining_opts = [opt for opt in task.options if opt.cli_name not in values]
    for pos in positionals:
        if not remaining_opts:
            raise CliUsageError(f"Unexpected positional argument {pos!r} for task {task.name!r}.")
        opt = remaining_opts.pop(0)
        coerced = coerce_option_value(opt, pos)
        values[opt.cli_name] = [coerced] if opt.is_list else coerced
    kwargs: dict[str, Any] = {}
    for opt in task.options:
        if opt.cli_name in values:
            kwargs[opt.param_name] = values[opt.cli_name]
        elif opt.required:
            raise CliUsageError(f"Missing required option --{opt.cli_name} for task {task.name!r}.")
    return kwargs


def _format_task_help(task: TaskDefinition) -> str:
    lines = [f"Task: {_SPACE.join(task.cli_path)} ({task.name})"]
    if task.description:
        lines.append(f"  {task.description}")
    if task.depends:
        deps = _COMMA_SEP.join(d if isinstance(d, str) else d.name for d in task.depends)
        lines.append(f"  depends: {deps}")
    if task.marks:
        lines.append(f"  marks: {_COMMA_SEP.join(task.marks)}")
    if task.requires:
        lines.append(f"  requires: {_COMMA_SEP.join(task.requires)}")
    if task.options:
        lines.append("  options:")
        for opt in task.options:
            status = "required" if opt.required else f"default={opt.default!r}"
            lines.append(f"    --{opt.cli_name} <{opt.format_type()}> ({status})")
    return "\n".join(lines)


def _cmd_ls(registry: TaskRegistry, rest: Sequence[str]) -> int:
    if rest:
        raise CliUsageError("ls does not take positional arguments.")
    for task in registry.ordered_tasks():
        summary = task.description.splitlines()[0] if task.description else ""
        path = _SPACE.join(task.cli_path)
        print(f"{path} ({task.name}) - {summary}" if summary else f"{path} ({task.name})")
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
    validate_graph(registry)
    print(f"OK ({len(registry.tasks)} task(s) validated)")
    return 0


def _cmd_plan(registry: TaskRegistry, rest: Sequence[str]) -> int:
    task, extra = _split_task_tokens(rest, registry)
    if extra:
        raise CliUsageError(f"Unexpected arguments to plan: {_SPACE.join(extra)}")
    order = plan_execution(registry, task.name)
    for index, name in enumerate(order, start=1):
        print(f"{index}. {name}")
    return 0


def _cmd_run(registry: TaskRegistry, rest: Sequence[str], *, is_verbose: bool) -> int:
    task, extra = _split_task_tokens(rest, registry)
    kwargs, wants_help = _parse_task_args(task, extra)
    if wants_help:
        print(_format_task_help(task))
        return 0
    report = run_plan(registry, task.name, kwargs, is_verbose=is_verbose)
    if report.failed:
        for failed_name in report.failed:
            print(f"FAILED {failed_name}: {report.errors[failed_name]}", file=sys.stderr)
        if report.blocked:
            print(f"BLOCKED: {_COMMA_SEP.join(report.blocked)}", file=sys.stderr)
        return report.exit_code
    return 0


def _dispatch(opts: _GlobalOpts) -> int:
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
    handlers = {"ls": _cmd_ls, "help": _cmd_help, "check": _cmd_check, "plan": _cmd_plan}
    if cmd in handlers:
        return handlers[cmd](registry, rest)
    if cmd == "run":
        return _cmd_run(registry, rest, is_verbose=opts.verbose)
    raise CliUsageError(f"Unknown command: {cmd}")


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entrypoint returning an OS exit code."""
    raw = list(sys.argv[1:] if argv is None else argv)
    try:
        opts = _parse_global_opts(raw)
        return _dispatch(opts)
    except TasknestError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.exit_code
