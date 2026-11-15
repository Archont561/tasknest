"""BDD and unit tests for tasknest.context ToolContext and subprocess execution."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from pytest_bdd import given, parsers, scenarios, then, when
from tasknest.context import CommandResult, ToolContext
from tasknest.errors import ToolError

scenarios(str(Path(__file__).resolve().parent.parent / "features/context.feature"))


@pytest.fixture
def ctx_state(tmp_path: Path) -> dict[str, object]:
    return {"repo_root": tmp_path, "result": None, "error": None}


@given(parsers.parse('a workspace with a subpackage root "{subpath}"'))
def given_workspace(ctx_state: dict[str, object], subpath: str) -> None:
    repo_root = ctx_state["repo_root"]
    assert isinstance(repo_root, Path)
    proj_root = (repo_root / subpath).resolve()
    proj_root.mkdir(parents=True, exist_ok=True)
    ctx_state["context"] = ToolContext(
        repo_root=repo_root, project_root=proj_root, task_name="demo"
    )
    ctx_state["subpath"] = subpath


@when("a task executes a command without specifying cwd")
def when_run_default_cwd(ctx_state: dict[str, object]) -> None:
    ctx = ctx_state["context"]
    assert isinstance(ctx, ToolContext)
    ctx_state["result"] = ctx.run(
        [sys.executable, "-c", "import pathlib; print(pathlib.Path.cwd())"],
        capture=True,
    )


@when(parsers.parse('a task executes a command with environment variable "{assignment}"'))
def when_run_with_env(ctx_state: dict[str, object], assignment: str) -> None:
    key, val = assignment.split("=", 1)
    ctx = ctx_state["context"]
    assert isinstance(ctx, ToolContext)
    ctx_state["result"] = ctx.run(
        [sys.executable, "-c", f"import os; print(os.environ[{key!r}])"],
        env={key: val},
        capture=True,
    )


@when("a task passes a raw shell string to the command helper")
def when_run_shell_string(ctx_state: dict[str, object]) -> None:
    ctx = ctx_state["context"]
    assert isinstance(ctx, ToolContext)
    try:
        ctx.run("echo hi")
    except ToolError as exc:
        ctx_state["error"] = exc


@when(parsers.parse("a task runs a command that exits with code {code:d}"))
def when_run_nonzero(ctx_state: dict[str, object], code: int) -> None:
    ctx = ctx_state["context"]
    assert isinstance(ctx, ToolContext)
    try:
        ctx.run([sys.executable, "-c", f"raise SystemExit({code})"])
    except ToolError as exc:
        ctx_state["error"] = exc


@when("a task runs a slow command with a short timeout")
def when_run_timeout(ctx_state: dict[str, object]) -> None:
    ctx = ctx_state["context"]
    assert isinstance(ctx, ToolContext)
    try:
        ctx.run([sys.executable, "-c", "import time; time.sleep(2)"], timeout=0.05)
    except ToolError as exc:
        ctx_state["error"] = exc


@then(parsers.parse('the command working directory is "{subpath}"'))
def then_cwd_matches(ctx_state: dict[str, object], subpath: str) -> None:
    repo_root = ctx_state["repo_root"]
    result = ctx_state["result"]
    assert isinstance(repo_root, Path)
    assert isinstance(result, CommandResult)
    expected = (repo_root / subpath).resolve()
    assert result.cwd == expected
    assert str(expected) in result.stdout


@then("the task context still exposes the repository root")
def then_repo_root_distinct(ctx_state: dict[str, object]) -> None:
    ctx = ctx_state["context"]
    repo_root = ctx_state["repo_root"]
    assert isinstance(ctx, ToolContext)
    assert isinstance(repo_root, Path)
    assert ctx.repo_root == repo_root


@then(parsers.parse('the captured command output contains "{text}"'))
def then_output_contains(ctx_state: dict[str, object], text: str) -> None:
    result = ctx_state["result"]
    assert isinstance(result, CommandResult)
    assert text in result.stdout


@then("a tool failure is raised explaining an argv sequence is required")
def then_argv_error(ctx_state: dict[str, object]) -> None:
    err = ctx_state["error"]
    assert isinstance(err, ToolError)
    assert "argv sequence" in str(err)


@then(parsers.parse("a tool failure is raised with exit code {code:d}"))
def then_exit_code_error(ctx_state: dict[str, object], code: int) -> None:
    err = ctx_state["error"]
    assert isinstance(err, ToolError)
    assert err.exit_code == code


@then("a tool failure is raised explaining the command timed out")
def then_timeout_error(ctx_state: dict[str, object]) -> None:
    err = ctx_state["error"]
    assert isinstance(err, ToolError)
    assert "timed out" in str(err)


def test_context_missing_executable_raises_tool_error(tmp_path: Path) -> None:
    ctx = ToolContext(repo_root=tmp_path, project_root=tmp_path, task_name="demo")
    with pytest.raises(ToolError, match="Failed to execute"):
        ctx.run(["definitely-nonexistent-binary-tasknest"])
