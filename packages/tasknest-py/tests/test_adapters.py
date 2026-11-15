"""Tests for built-in ecosystem adapters and conservative pytest fallback."""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING

import pytest
from tasknest.adapters import (
    BunAdapter,
    PytestAdapter,
    RuffAdapter,
    ToolAdapter,
    require_executable,
    select_pytest_targets,
)
from tasknest.context import ToolContext
from tasknest.errors import ToolError

if TYPE_CHECKING:
    from pathlib import Path


def test_require_executable_diagnoses_missing_without_installing() -> None:
    with pytest.raises(ToolError, match="was not found on PATH"):
        require_executable("definitely-missing-tasknest-tool-xyz")


def test_select_pytest_targets_conservative_fallback() -> None:
    mapping = {
        "src/app.py": ["tests/test_app.py"],
        "src/cli.py": ["tests/test_cli.py", "tests/test_app.py"],
    }
    plan = select_pytest_targets(["src/cli.py"], mapping)
    assert plan.targets == ("tests/test_cli.py", "tests/test_app.py")
    assert plan.fallback_reason is None

    unmapped = select_pytest_targets(["src/new_mod.py"], mapping)
    assert unmapped.targets == ("tests",)
    assert unmapped.fallback_reason is not None
    assert "unmapped" in unmapped.fallback_reason

    global_trigger = select_pytest_targets(["src/app.py", "pyproject.toml"], mapping)
    assert global_trigger.targets == ("tests",)
    assert global_trigger.fallback_reason is not None
    assert "global trigger" in global_trigger.fallback_reason

    no_map = select_pytest_targets(["src/app.py"], None)
    assert no_map.targets == ("tests",)
    assert no_map.fallback_reason is not None


def test_adapter_escape_hatch_and_pytest_run_affected(tmp_path: Path) -> None:
    test_file = tmp_path / "tests/test_sample.py"
    test_file.parent.mkdir(parents=True)
    test_file.write_text("def test_ok() -> None:\n    assert True\n", encoding="utf-8")

    ctx = ToolContext(repo_root=tmp_path, project_root=tmp_path, task_name="adapt")
    adapter = ToolAdapter(ctx)
    res = adapter.exec([sys.executable, "-c", "print('ESCAPE_HATCH')"], capture=True)
    assert "ESCAPE_HATCH" in res.stdout

    pytest_adapter = PytestAdapter(ctx)
    plan, cmd_res = pytest_adapter.run_affected(
        ["src/sample.py"],
        {"src/sample.py": ["tests/test_sample.py"]},
        capture=True,
    )
    assert plan.targets == ("tests/test_sample.py",)
    assert cmd_res is not None
    assert cmd_res.returncode == 0

    assert RuffAdapter(ctx).executable == "ruff"
    assert BunAdapter(ctx).executable == "bun"
