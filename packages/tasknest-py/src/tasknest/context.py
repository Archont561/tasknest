"""Execution context, structured outputs, dependency reads, and scoped env."""

from __future__ import annotations

import hashlib
import json
import os
import pickle
import subprocess
import sys
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from tasknest._process import ProcessSpec, run_streaming_process
from tasknest.affected import AffectedContext
from tasknest.errors import ToolError

if TYPE_CHECKING:
    from collections.abc import Sequence
    from pathlib import Path
    from threading import Event

OutputFormat = Literal["json", "pickle"]


def python_abi_tag() -> str:
    """Return local Python ABI fingerprint for opt-in pickle cache keys."""
    return f"py{sys.version_info.major}.{sys.version_info.minor}-{sys.platform}"


@dataclass(frozen=True)
class CommandResult:
    """Result of running a subprocess via ToolContext."""

    argv: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str
    cwd: Path


@dataclass(frozen=True)
class BufferedOutput:
    """Validated structured output buffered until task completion."""

    payload: Any
    output_format: OutputFormat
    digest: str
    raw_bytes: bytes
    abi_tag: str | None = None


class DepsMapping(Mapping[str, Any]):
    """Read-only dependency output view restricted to a task's declared depends."""

    def __init__(
        self,
        owner_name: str,
        allowed_deps: frozenset[str],
        values: Mapping[str, Any],
    ) -> None:
        self._owner_name = owner_name
        self._allowed_deps = allowed_deps
        self._values = {k: values[k] for k in allowed_deps if k in values}

    def __getitem__(self, key: str) -> Any:
        if key not in self._allowed_deps:
            raise ToolError(
                f"Task {self._owner_name!r} cannot read ctx.deps[{key!r}]: not in declared depends."
            )
        if key not in self._values:
            raise KeyError(f"Dependency {key!r} did not commit an output.")
        return self._values[key]

    def __iter__(self) -> Iterator[str]:
        return iter(self._values)

    def __len__(self) -> int:
        return len(self._values)

    def __contains__(self, key: object) -> bool:
        return isinstance(key, str) and key in self._values

    def get(self, key: str, default: Any = None) -> Any:
        """Return committed output for declared dependency key or default."""
        if key not in self._allowed_deps:
            raise ToolError(
                f"Task {self._owner_name!r} cannot read ctx.deps[{key!r}]: not in declared depends."
            )
        return self._values.get(key, default)


@dataclass(frozen=True)
class _SubprocessSpec:
    args: tuple[str, ...]
    workdir: Path
    env: dict[str, str]
    timeout: float | None
    check: bool
    capture: bool
    cancel_event: Event | None = None
    line_prefix: str | None = None
    quiet_stdout: bool = False


def _build_env(
    task_env: Mapping[str, str],
    unset_keys: frozenset[str],
    overrides: Mapping[str, str] | None,
) -> dict[str, str]:
    merged = os.environ.copy()
    for removed in unset_keys:
        merged.pop(removed, None)
    merged.update(task_env)
    if overrides:
        merged.update(overrides)
    return merged


def _execute_spec(spec: _SubprocessSpec) -> CommandResult:
    if spec.cancel_event is not None or spec.line_prefix is not None:
        code, stdout_text, stderr_text = run_streaming_process(
            ProcessSpec(
                args=spec.args,
                workdir=spec.workdir,
                env=spec.env,
                timeout=spec.timeout,
                check=spec.check,
                capture=spec.capture,
                cancel_event=spec.cancel_event,
                line_prefix=spec.line_prefix,
                quiet_stdout=spec.quiet_stdout,
            )
        )
        result = CommandResult(
            argv=spec.args,
            returncode=code,
            stdout=stdout_text,
            stderr=stderr_text,
            cwd=spec.workdir,
        )
    else:
        try:
            proc = subprocess.run(  # noqa: S603 - explicit argv list with shell=False
                spec.args,
                cwd=spec.workdir,
                env=spec.env,
                shell=False,
                timeout=spec.timeout,
                text=True,
                capture_output=spec.capture,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise ToolError(
                f"Command timed out after {spec.timeout}s: {' '.join(spec.args)}"
            ) from exc
        except OSError as exc:
            raise ToolError(f"Failed to execute command {spec.args[0]!r}: {exc}") from exc
        result = CommandResult(
            argv=spec.args,
            returncode=proc.returncode,
            stdout=proc.stdout or "",
            stderr=proc.stderr or "",
            cwd=spec.workdir,
        )
    if spec.check and result.returncode != 0:
        raise ToolError(
            f"Command exited with code {result.returncode}: {' '.join(spec.args)}",
            exit_code=result.returncode,
        )
    return result


def _encode_json_output(value: Any) -> BufferedOutput:
    try:
        raw_text = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ToolError(f"ctx.output() requires JSON-serializable data: {exc}") from exc
    raw_bytes = raw_text.encode("utf-8")
    digest = hashlib.sha256(raw_bytes).hexdigest()
    return BufferedOutput(
        payload=json.loads(raw_text),
        output_format="json",
        digest=digest,
        raw_bytes=raw_bytes,
    )


def _encode_pickle_output(value: Any) -> BufferedOutput:
    try:
        raw_bytes = pickle.dumps(value)
    except Exception as exc:
        raise ToolError(f"ctx.output(format='pickle') failed to serialize value: {exc}") from exc
    abi = python_abi_tag()
    digest = hashlib.sha256(abi.encode("utf-8") + b":" + raw_bytes).hexdigest()
    return BufferedOutput(
        payload=value,
        output_format="pickle",
        digest=digest,
        raw_bytes=raw_bytes,
        abi_tag=abi,
    )


@dataclass
class ToolContext:
    """Runtime execution context passed to tasks."""

    repo_root: Path
    project_root: Path
    task_name: str
    verbose: bool = False
    base_env: Mapping[str, str] = field(default_factory=dict)
    deps: DepsMapping = field(default_factory=lambda: DepsMapping("", frozenset(), {}))
    affected: AffectedContext = field(default_factory=AffectedContext)
    quiet_stdout: bool = False
    cancel_event: Event | None = None
    line_prefix: str | None = None
    _task_env: dict[str, str] = field(init=False, repr=False)

    @property
    def is_cancelled(self) -> bool:
        """Return True when the current execution has been cancelled."""
        return self.cancel_event is not None and self.cancel_event.is_set()

    _unset_env: set[str] = field(init=False, repr=False, default_factory=set)
    _accessed_env: set[str] = field(init=False, repr=False, default_factory=set)
    _pending_output: BufferedOutput | None = field(init=False, repr=False, default=None)
    _commands: list[CommandResult] = field(init=False, repr=False, default_factory=list)

    def __post_init__(self) -> None:
        self._task_env = dict(self.base_env)

    def output(self, value: Any, *, format: OutputFormat = "json") -> str:  # noqa: A002
        """Buffer a validated structured output for commit on task success."""
        if format == "json":
            encoded = _encode_json_output(value)
        elif format == "pickle":
            encoded = _encode_pickle_output(value)
        else:
            raise ToolError(
                f"Unsupported ctx.output format {format!r}; expected 'json' or 'pickle'."
            )
        self._pending_output = encoded
        return encoded.digest

    def env(self, name: str, default: str | None = None) -> str | None:
        """Read an environment variable from task-local env over process env and track key."""
        self._accessed_env.add(name)
        if name in self._task_env:
            return self._task_env[name]
        if name in self._unset_env:
            return default
        return os.environ.get(name, default)

    def set_env(self, name: str, value: str) -> None:
        """Set a task-local environment variable without mutating os.environ."""
        self._unset_env.discard(name)
        self._task_env[name] = value

    def unset_env(self, name: str) -> None:
        """Unset a task-local environment variable without mutating os.environ."""
        self._task_env.pop(name, None)
        self._unset_env.add(name)

    @contextmanager
    def scoped_env(self, **updates: str | None) -> Iterator[None]:
        """Temporarily apply task-local env overrides for a with-block."""
        prev_env = dict(self._task_env)
        prev_unset = set(self._unset_env)
        for key, value in updates.items():
            if value is None:
                self.unset_env(key)
            else:
                self.set_env(key, value)
        try:
            yield
        finally:
            self._task_env = prev_env
            self._unset_env = prev_unset

    def accessed_env_snapshot(self) -> dict[str, str | None]:
        """Return resolved values for all env keys queried via ctx.env()."""
        snapshot: dict[str, str | None] = {}
        for key in sorted(self._accessed_env):
            if key in self._task_env:
                snapshot[key] = self._task_env[key]
            elif key in self._unset_env:
                snapshot[key] = None
            else:
                snapshot[key] = os.environ.get(key)
        return snapshot

    def consume_pending_output(self) -> BufferedOutput | None:
        """Return and clear any buffered ctx.output payload."""
        pending = self._pending_output
        self._pending_output = None
        return pending

    def recorded_commands(self) -> tuple[CommandResult, ...]:
        """Return commands executed through ctx.run during this task invocation."""
        return tuple(self._commands)

    def run(
        self,
        argv: Sequence[str],
        *,
        cwd: Path | None = None,
        env: Mapping[str, str] | None = None,
        timeout: float | None = None,
        check: bool = True,
        capture: bool = False,
    ) -> CommandResult:
        """Execute an external command via argv without invoking a shell."""
        if isinstance(argv, (str, bytes)) or not argv:
            raise ToolError("ctx.run() requires a non-empty argv sequence, not a shell string.")
        workdir = (
            (self.project_root / cwd)
            if cwd and not cwd.is_absolute()
            else (cwd or self.project_root)
        )
        spec = _SubprocessSpec(
            args=tuple(str(part) for part in argv),
            workdir=workdir,
            env=_build_env(self._task_env, frozenset(self._unset_env), env),
            timeout=timeout,
            check=check,
            capture=capture or self.quiet_stdout,
            cancel_event=self.cancel_event,
            line_prefix=self.line_prefix,
            quiet_stdout=self.quiet_stdout,
        )
        try:
            result = _execute_spec(spec)
        except ToolError as exc:
            self._commands.append(
                CommandResult(
                    argv=spec.args,
                    returncode=exc.exit_code,
                    stdout="",
                    stderr=str(exc),
                    cwd=spec.workdir,
                )
            )
            raise
        self._commands.append(result)
        return result
