"""BDD, Hypothesis, and subprocess tests for tasknest.cli."""

from __future__ import annotations

import contextlib
import io
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest
from hypothesis import given
from hypothesis import strategies as st
from pytest_bdd import given as bdd_given
from pytest_bdd import parsers, scenarios, then, when
from tasknest import VERSION
from tasknest.cli import main

scenarios(str(Path(__file__).resolve().parent.parent / "features/cli.feature"))


@pytest.fixture
def cli_state(tmp_path: Path) -> dict[str, object]:
    tools = tmp_path / "tools"
    tools.mkdir()
    return {"workspace": tmp_path, "tools": tools, "exit_code": None, "out": "", "err": ""}


@bdd_given(
    parsers.parse('a CLI workspace with nested task "{nested}" and dependent task "{dep_file}"')
)
def given_nested_cli_workspace(cli_state: dict[str, object], nested: str, dep_file: str) -> None:
    tools = cli_state["tools"]
    assert isinstance(tools, Path)
    nested_path = tools / nested
    nested_path.parent.mkdir(parents=True, exist_ok=True)
    nested_path.write_text(
        "from tasknest import ToolContext, tool\n"
        "@tool()\n"
        "def dev(ctx: ToolContext) -> None:\n"
        '    """Run dev check."""\n'
        "    print('DEV_OK')\n",
        encoding="utf-8",
    )
    (tools / dep_file).write_text(
        "from tasknest import ToolContext, tool\n"
        "@tool(depends=['check.dev'])\n"
        "def lint(ctx: ToolContext) -> None:\n"
        '    """Lint workspace."""\n'
        "    print('LINT_OK')\n",
        encoding="utf-8",
    )


@bdd_given(parsers.parse('a CLI workspace with typed task "{task_file}"'))
def given_typed_cli_workspace(cli_state: dict[str, object], task_file: str) -> None:
    tools = cli_state["tools"]
    assert isinstance(tools, Path)
    (tools / task_file).write_text(
        "from pathlib import Path\n"
        "from typing import Literal\n"
        "from tasknest import ToolContext, tool\n"
        "@tool()\n"
        "def greet(\n"
        "    ctx: ToolContext,\n"
        "    target: Path,\n"
        "    fix: bool = False,\n"
        "    jobs: int = 1,\n"
        "    mode: Literal['fast', 'full'] = 'fast',\n"
        "    tags: list[str] | None = None,\n"
        ") -> None:\n"
        '    """Typed task."""\n'
        "    joined = ','.join(tags or [])\n"
        "    print(f'GREET:{target}:{fix}:{jobs}:{mode}:{joined}')\n",
        encoding="utf-8",
    )


@bdd_given(
    parsers.parse(
        'a CLI workspace with task "{parent_file}" accepting option "root" '
        'and child task "{child_file}"'
    )
)
def given_ambiguous_cli_workspace(
    cli_state: dict[str, object], parent_file: str, child_file: str
) -> None:
    tools = cli_state["tools"]
    assert isinstance(tools, Path)
    (tools / parent_file).write_text(
        "from tasknest import tool\n"
        "@tool()\n"
        "def a(arg: str = 'default', root: str = 'task-root') -> None:\n"
        '    """Parent task."""\n'
        "    print(f'A:{arg}:{root}')\n",
        encoding="utf-8",
    )
    child_path = tools / child_file
    child_path.parent.mkdir(parents=True, exist_ok=True)
    child_path.write_text(
        "from tasknest import tool\n"
        "@tool()\n"
        "def b() -> None:\n"
        '    """Child task."""\n'
        "    print('B_CHILD')\n",
        encoding="utf-8",
    )


@when(parsers.parse('I run the CLI with "{cmdline}"'))
def when_run_cli(
    cli_state: dict[str, object],
    capsys: pytest.CaptureFixture[str],
    cmdline: str,
) -> None:
    workspace = cli_state["workspace"]
    assert isinstance(workspace, Path)
    capsys.readouterr()
    argv = ["--root", str(workspace), *cmdline.split()]
    cli_state["exit_code"] = main(argv)
    captured = capsys.readouterr()
    cli_state["out"] = captured.out
    cli_state["err"] = captured.err


@then(parsers.parse('the CLI succeeds with output containing "{expected}"'))
def then_cli_succeeds(cli_state: dict[str, object], expected: str) -> None:
    assert cli_state["exit_code"] == 0
    assert expected in str(cli_state["out"])


@then(parsers.parse("the CLI fails with exit code {code:d}"))
def then_cli_fails(cli_state: dict[str, object], code: int) -> None:
    assert cli_state["exit_code"] == code


@given(jobs=st.integers(min_value=-1000, max_value=1000))
def test_property_cli_passes_arbitrary_typed_integers(jobs: int) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        workspace = Path(tmp)
        tools = workspace / "tools"
        tools.mkdir()
        (tools / "num.py").write_text(
            "from tasknest import tool\n"
            "@tool()\n"
            "def num(jobs: int = 0) -> None:\n"
            "    print(f'JOBS={jobs}')\n",
            encoding="utf-8",
        )
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = main(["--root", str(workspace), "run", "num", f"--jobs={jobs}"])
        assert rc == 0
        assert f"JOBS={jobs}" in buf.getvalue()


def test_python_module_entrypoint_prints_version() -> None:
    pkg_src = Path(__file__).resolve().parent.parent / "src"
    env = os.environ.copy()
    env["PYTHONPATH"] = str(pkg_src)
    proc = subprocess.run(  # noqa: S603 - explicit python -m tasknest invocation
        [sys.executable, "-m", "tasknest", "--version"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    assert proc.returncode == 0
    assert proc.stdout.strip().startswith(f"tasknest {VERSION}")
