"""In-process CLI testing utilities and isolated fixture workspace helpers."""

from __future__ import annotations

import contextlib
import io
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from tasknest.cli import main

if TYPE_CHECKING:
    from collections.abc import Iterator, Mapping, Sequence


@dataclass(frozen=True)
class CliResult:
    """Captured result from invoking the Tasknest CLI in-process."""

    exit_code: int
    stdout: str
    stderr: str
    exception: BaseException | None = None


@contextlib.contextmanager
def _scoped_env_and_cwd(cwd: Path | None, env: Mapping[str, str] | None) -> Iterator[None]:
    prev_cwd = Path.cwd()
    saved_env: dict[str, str | None] = {}
    if env is not None:
        for key, val in env.items():
            saved_env[key] = os.environ.get(key)
            os.environ[key] = val
    try:
        if cwd is not None:
            os.chdir(cwd)
        yield
    finally:
        if cwd is not None:
            os.chdir(prev_cwd)
        for key, old in saved_env.items():
            if old is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = old


class CliRunner:
    """In-process test runner for Tasknest CLI invocations."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = root

    def _run_captured(
        self, argv: list[str], cwd: Path | None, env: Mapping[str, str] | None
    ) -> CliResult:
        out_buf = io.StringIO()
        err_buf = io.StringIO()
        exc: BaseException | None = None
        exit_code = 0
        with (
            _scoped_env_and_cwd(cwd, env),
            contextlib.redirect_stdout(out_buf),
            contextlib.redirect_stderr(err_buf),
        ):
            try:
                exit_code = main(argv)
            except BaseException as err:  # pragma: no cover - safety net for unexpected errors
                exc = err
                exit_code = 1
        return CliResult(
            exit_code=exit_code,
            stdout=out_buf.getvalue(),
            stderr=err_buf.getvalue(),
            exception=exc,
        )

    def invoke(
        self,
        args: Sequence[str],
        *,
        cwd: Path | None = None,
        env: Mapping[str, str] | None = None,
    ) -> CliResult:
        """Invoke the CLI and capture exit code, stdout, stderr, and exception."""
        argv = list(args)
        if self.root is not None and "--root" not in argv:
            argv = ["--root", str(self.root), *argv]
        return self._run_captured(argv, cwd, env)

    @contextlib.contextmanager
    def isolated_workspace(self, files: Mapping[str, str] | None = None) -> Iterator[Path]:
        """Create an isolated temporary project directory with optional files."""
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            if files:
                for rel_path, content in files.items():
                    target = workspace / rel_path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(content, encoding="utf-8")
            yield workspace
