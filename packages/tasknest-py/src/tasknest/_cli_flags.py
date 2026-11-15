"""CLI flag and argument parsing helpers for tasknest.cli."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from tasknest.errors import CliUsageError
from tasknest.task import TaskDefinition, TaskOption, coerce_option_value

if TYPE_CHECKING:
    from collections.abc import Sequence

    from tasknest.cache import CacheMode

DASH = "-"
EQUALS = "="
DOUBLE_DASH = "--"
_NO_PREFIX = "no-"
_PAIR_STEP = 2
_NEG_PREFIX_LEN = 3
_FLAG_MARK = "--mark"
_FLAG_JOBS = "--jobs"
_FLAG_REPORT = "--report"
_FLAG_CHANGED_BASE = "--changed-base"
_FLAG_CHANGED = "--changed"
_FLAG_INTERVAL = "--interval"
_FLAG_MAX_CYCLES = "--max-cycles"


@dataclass(frozen=True)
class GlobalOpts:
    """Parsed global CLI options before the subcommand."""

    root: Path
    config: Path | None
    verbose: bool
    show_help: bool
    show_version: bool
    rest: list[str]


@dataclass
class FlagState:
    """Mutable option parser state for a single task invocation."""

    by_name: dict[str, TaskOption]
    values: dict[str, Any]


@dataclass
class RunCliFlags:
    """Runner-level options accepted before the task path on `run`."""

    marks: list[str] = field(default_factory=list)
    jobs: int | None = None
    cache_mode: CacheMode = "default"
    json_output: bool = False
    report_path: Path | None = None
    changed_base: str | None = None
    changed_paths: list[str] = field(default_factory=list)
    force_all: bool = False
    fail_fast: bool = False


@dataclass
class WatchCliFlags:
    """Runner-level options accepted before the task path on `watch`."""

    interval_ms: int = 250
    max_cycles: int | None = None
    jobs: int | None = None
    json_output: bool = False


def consume_value(tokens: Sequence[str], index: int, flag: str) -> tuple[str, int]:
    """Consume the next token as a required option value."""
    if index + 1 >= len(tokens):
        raise CliUsageError(f"Global option {flag} requires a value.")
    return tokens[index + 1], index + _PAIR_STEP


def parse_global_opts(argv: Sequence[str]) -> GlobalOpts:
    """Parse global options occurring before the CLI subcommand."""
    root, config = Path.cwd(), None
    verbose = show_help = show_version = False
    idx = 0
    while idx < len(argv):
        tok = argv[idx]
        if tok == "--root":
            val, idx = consume_value(argv, idx, tok)
            root = Path(val)
        elif tok == "--config":
            val, idx = consume_value(argv, idx, tok)
            config = Path(val)
        elif tok in ("-v", "--verbose"):
            verbose, idx = True, idx + 1
        elif tok in ("-h", "--help"):
            show_help, idx = True, idx + 1
        elif tok == "--version":
            show_version, idx = True, idx + 1
        elif tok.startswith(DASH):
            raise CliUsageError(f"Unknown global option before command: {tok}")
        else:
            break
    return GlobalOpts(root, config, verbose, show_help, show_version, list(argv[idx:]))


def _apply_negated_flag(flag: str, inline: str | None, state: FlagState) -> bool:
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
    flag: str, inline: str | None, rest: Sequence[str], idx: int, state: FlagState
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


def _finalize_task_kwargs(
    task: TaskDefinition, values: dict[str, Any], positionals: list[str]
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


def parse_task_args(task: TaskDefinition, args: Sequence[str]) -> tuple[dict[str, Any], bool]:
    """Parse task-specific CLI flags and positional arguments."""
    state = FlagState(by_name={opt.cli_name: opt for opt in task.options}, values={})
    positionals: list[str] = []
    idx = 0
    while idx < len(args):
        tok = args[idx]
        if tok in ("-h", "--help"):
            return {}, True
        if tok == DOUBLE_DASH:
            positionals.extend(args[idx + 1 :])
            break
        if tok.startswith(DOUBLE_DASH):
            body = tok[len(DOUBLE_DASH) :]
            flag, inline = body.split(EQUALS, 1) if EQUALS in body else (body, None)
            idx = _apply_long_flag(flag, inline, args, idx, state)
        elif tok.startswith(DASH):
            raise CliUsageError(f"Unknown task option: {tok}")
        else:
            positionals.append(tok)
            idx += 1
    return _finalize_task_kwargs(task, state.values, positionals), False


def parse_mark_flags(tokens: Sequence[str]) -> tuple[list[str], list[str]]:
    """Parse leading --mark options before a subcommand target."""
    marks: list[str] = []
    idx = 0
    while idx < len(tokens):
        tok = tokens[idx]
        if tok == _FLAG_MARK:
            val, idx = consume_value(tokens, idx, tok)
            marks.append(val)
        elif tok.startswith(f"{_FLAG_MARK}="):
            marks.append(tok.split(EQUALS, 1)[1])
            idx += 1
        else:
            break
    return marks, list(tokens[idx:])


def _parse_positive_int(raw: str, flag: str) -> int:
    try:
        value = int(raw)
    except ValueError as exc:
        raise CliUsageError(f"Option {flag} requires an integer, got {raw!r}.") from exc
    if value < 1:
        raise CliUsageError(f"Option {flag} must be >= 1.")
    return value


def _consume_value_flag(tok: str, tokens: Sequence[str], idx: int, flag: str) -> tuple[str, int]:
    if EQUALS in tok:
        return tok.split(EQUALS, 1)[1], idx + 1
    return consume_value(tokens, idx, flag)


def _match_value_flag(tok: str, name: str) -> bool:
    return tok == name or tok.startswith(f"{name}=")


def _apply_run_bool_flag(tok: str, idx: int, flags: RunCliFlags) -> int:
    if tok == "--force":
        flags.cache_mode = "force"
        flags.force_all = True
    elif tok == "--no-cache":
        flags.cache_mode = "no_cache"
    elif tok == "--json":
        flags.json_output = True
    elif tok == "--all":
        flags.force_all = True
    elif tok == "--fail-fast":
        flags.fail_fast = True
    else:
        raise CliUsageError(f"Unknown option for run: {tok}")
    return idx + 1


def _apply_run_flag_token(tok: str, tokens: Sequence[str], idx: int, flags: RunCliFlags) -> int:
    if _match_value_flag(tok, _FLAG_MARK):
        val, next_idx = _consume_value_flag(tok, tokens, idx, _FLAG_MARK)
        flags.marks.append(val)
        return next_idx
    if tok == "-j" or _match_value_flag(tok, _FLAG_JOBS):
        val, next_idx = _consume_value_flag(tok, tokens, idx, _FLAG_JOBS)
        flags.jobs = _parse_positive_int(val, _FLAG_JOBS)
        return next_idx
    if _match_value_flag(tok, _FLAG_REPORT):
        val, next_idx = _consume_value_flag(tok, tokens, idx, _FLAG_REPORT)
        flags.report_path = Path(val)
        return next_idx
    if _match_value_flag(tok, _FLAG_CHANGED_BASE):
        flags.changed_base, next_idx = _consume_value_flag(tok, tokens, idx, _FLAG_CHANGED_BASE)
        return next_idx
    if _match_value_flag(tok, _FLAG_CHANGED):
        val, next_idx = _consume_value_flag(tok, tokens, idx, _FLAG_CHANGED)
        flags.changed_paths.append(val)
        return next_idx
    return _apply_run_bool_flag(tok, idx, flags)


def parse_run_flags(tokens: Sequence[str]) -> tuple[RunCliFlags, list[str]]:
    """Parse leading runner flags before the task path on `run`."""
    flags = RunCliFlags()
    idx = 0
    while idx < len(tokens):
        tok = tokens[idx]
        if not tok.startswith(DASH):
            break
        idx = _apply_run_flag_token(tok, tokens, idx, flags)
    return flags, list(tokens[idx:])


def parse_watch_flags(tokens: Sequence[str]) -> tuple[WatchCliFlags, list[str]]:
    """Parse leading runner flags before the task path on `watch`."""
    flags = WatchCliFlags()
    idx = 0
    while idx < len(tokens):
        tok = tokens[idx]
        if not tok.startswith(DASH):
            break
        if _match_value_flag(tok, _FLAG_INTERVAL):
            val, idx = _consume_value_flag(tok, tokens, idx, _FLAG_INTERVAL)
            flags.interval_ms = _parse_positive_int(val, _FLAG_INTERVAL)
        elif _match_value_flag(tok, _FLAG_MAX_CYCLES):
            val, idx = _consume_value_flag(tok, tokens, idx, _FLAG_MAX_CYCLES)
            flags.max_cycles = _parse_positive_int(val, _FLAG_MAX_CYCLES)
        elif tok == "-j" or _match_value_flag(tok, _FLAG_JOBS):
            val, idx = _consume_value_flag(tok, tokens, idx, _FLAG_JOBS)
            flags.jobs = _parse_positive_int(val, _FLAG_JOBS)
        elif tok == "--json":
            flags.json_output, idx = True, idx + 1
        else:
            raise CliUsageError(f"Unknown option for watch: {tok}")
    return flags, list(tokens[idx:])


def parse_skill_flags(rest: Sequence[str]) -> tuple[bool, bool, Path | None, Path | None]:
    """Parse flags for the `skill` subcommand."""
    write_mode = force = False
    output_path: Path | None = None
    template_path: Path | None = None
    idx = 0
    while idx < len(rest):
        tok = rest[idx]
        if tok == "--write":
            write_mode, idx = True, idx + 1
        elif tok == "--check":
            write_mode, idx = False, idx + 1
        elif tok == "--force":
            force, idx = True, idx + 1
        elif tok == "--output":
            val, idx = consume_value(rest, idx, tok)
            output_path = Path(val)
        elif tok == "--template":
            val, idx = consume_value(rest, idx, tok)
            template_path = Path(val)
        else:
            raise CliUsageError(f"Unknown option for skill: {tok}")
    return write_mode, force, output_path, template_path
