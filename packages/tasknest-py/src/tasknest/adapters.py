"""Built-in ecosystem adapters backed by ToolContext subprocess execution."""

from __future__ import annotations

import shutil
import sys
from typing import TYPE_CHECKING

from tasknest.affected import (
    AffectedContext,
    ChangedFile,
    SelectionPolicy,
    select_conservative_targets,
)
from tasknest.affected import (
    AffectedTestPlan as AffectedTestPlan,
)
from tasknest.errors import ToolError

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence
    from pathlib import Path

    from tasknest.context import CommandResult, ToolContext


def find_executable(name: str) -> str | None:
    """Return resolved executable path if present on PATH without installing."""
    return shutil.which(name)


def require_executable(name: str) -> str:
    """Diagnose missing external executable without installing it."""
    resolved = find_executable(name)
    if resolved is None:
        raise ToolError(
            f"Required external executable {name!r} was not found on PATH; "
            "install it in your environment before running this task."
        )
    return resolved


def select_pytest_targets(
    changed_files: AffectedContext | Sequence[ChangedFile | str],
    mapping: Mapping[str, Sequence[str]] | None,
    *,
    default_target: str = "tests",
    always_full: Sequence[str] = ("pyproject.toml", "conftest.py", "tests/conftest.py"),
    force_all: bool = False,
) -> AffectedTestPlan:
    """Select affected pytest targets or fall back conservatively to default_target."""
    policy = SelectionPolicy(
        default_target=default_target,
        always_full=always_full,
        force_all=force_all,
    )
    return select_conservative_targets(changed_files, mapping, policy)


class ToolAdapter:
    """Base adapter sharing ToolContext subprocess and executable diagnostics."""

    executable: str = ""

    def __init__(self, ctx: ToolContext) -> None:
        self.ctx = ctx

    def check_available(self) -> str:
        """Verify the adapter's external executable is installed."""
        return require_executable(self.executable)

    def exec(
        self,
        argv: Sequence[str],
        *,
        cwd: Path | None = None,
        capture: bool = False,
    ) -> CommandResult:
        """Escape hatch to execute an explicit argv command via ToolContext."""
        return self.ctx.run(argv, cwd=cwd, capture=capture)


class RuffAdapter(ToolAdapter):
    """Adapter for ruff lint and format checks."""

    executable = "ruff"

    def check(self, *paths: str, fix: bool = False) -> CommandResult:
        """Run ruff check on specified paths."""
        exe = self.check_available()
        argv = [exe, "check", *(["--fix"] if fix else []), *(paths or (".",))]
        return self.exec(argv)

    def format_check(self, *paths: str) -> CommandResult:
        """Run ruff format --check on specified paths."""
        exe = self.check_available()
        return self.exec([exe, "format", "--check", *(paths or (".",))])


class PytestAdapter(ToolAdapter):
    """Adapter for pytest execution with conservative affected selection."""

    executable = "pytest"

    def check_available(self) -> str:
        """Verify pytest is importable or on PATH without installing it."""
        if find_executable(self.executable) is not None:
            return self.executable
        probe = self.ctx.run([sys.executable, "-c", "import pytest"], check=False, capture=True)
        if probe.returncode != 0:
            raise ToolError(
                "Required external tool 'pytest' is not available in this Python environment."
            )
        return self.executable

    def run(self, *targets: str, capture: bool = False) -> CommandResult:
        """Execute pytest on the given test targets."""
        self.check_available()
        return self.exec([sys.executable, "-m", "pytest", *targets], capture=capture)

    def run_affected(
        self,
        changed_files: Sequence[str],
        mapping: Mapping[str, Sequence[str]] | None = None,
        *,
        default_target: str = "tests",
        capture: bool = False,
    ) -> tuple[AffectedTestPlan, CommandResult | None]:
        """Run mapped affected tests, falling back conservatively when unknown."""
        plan = select_pytest_targets(changed_files, mapping, default_target=default_target)
        if not plan.targets:
            return plan, None
        return plan, self.run(*plan.targets, capture=capture)


class BunAdapter(ToolAdapter):
    """Adapter for Bun test and package operations."""

    executable = "bun"

    def test(self, *targets: str, coverage: bool = False) -> CommandResult:
        """Run bun test with optional coverage."""
        exe = self.check_available()
        argv = [exe, "test", *(["--coverage"] if coverage else []), *targets]
        return self.exec(argv)


class ActionlintAdapter(ToolAdapter):
    """Adapter for GitHub Actions workflow linting via actionlint."""

    executable = "actionlint"

    def check(self, *files: str) -> CommandResult:
        """Run actionlint on workflow files."""
        exe = self.check_available()
        return self.exec([exe, *files])
