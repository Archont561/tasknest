"""Execution context and argv-based subprocess helper."""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from tasknest.errors import ToolError

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence
    from pathlib import Path


@dataclass(frozen=True)
class CommandResult:
    """Result of running a subprocess via ToolContext."""

    argv: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str
    cwd: Path


@dataclass(frozen=True)
class _SubprocessSpec:
    args: tuple[str, ...]
    workdir: Path
    env: dict[str, str]
    timeout: float | None
    check: bool
    capture: bool


def _build_env(base_env: Mapping[str, str], overrides: Mapping[str, str] | None) -> dict[str, str]:
    merged = os.environ.copy()
    merged.update(base_env)
    if overrides:
        merged.update(overrides)
    return merged


def _execute_spec(spec: _SubprocessSpec) -> CommandResult:
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
        raise ToolError(f"Command timed out after {spec.timeout}s: {' '.join(spec.args)}") from exc
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


@dataclass
class ToolContext:
    """Runtime execution context passed to tasks."""

    repo_root: Path
    project_root: Path
    task_name: str
    verbose: bool = False
    base_env: Mapping[str, str] = field(default_factory=dict)

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
            env=_build_env(self.base_env, env),
            timeout=timeout,
            check=check,
            capture=capture,
        )
        return _execute_spec(spec)
