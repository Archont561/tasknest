"""Tests for CliRunner and subprocess CLI integration."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from tasknest.testing import CliRunner


def test_clirunner_captures_exit_stdout_stderr_and_isolates_workspace() -> None:
    base_runner = CliRunner()
    with base_runner.isolated_workspace(
        {
            "tools/hello.py": (
                "from tasknest import tool\n"
                "@tool()\n"
                "def hello(who: str = 'world') -> None:\n"
                "    '''Say hello.'''\n"
                "    print(f'HELLO:{who}')\n"
            ),
            "tools/fail.py": (
                "from tasknest import ToolError, tool\n"
                "@tool()\n"
                "def fail() -> None:\n"
                "    '''Always fail.'''\n"
                "    raise ToolError('boom', exit_code=3)\n"
            ),
        }
    ) as workspace:
        runner = CliRunner(workspace)
        ok = runner.invoke(["run", "hello", "--who", "tasknest"])
        assert ok.exit_code == 0
        assert "HELLO:tasknest" in ok.stdout
        assert ok.stderr == ""
        assert ok.exception is None

        bad = runner.invoke(["run", "fail"])
        assert bad.exit_code == 3
        assert "boom" in bad.stderr


def test_subprocess_entrypoint_isolates_projects_and_reports_failures() -> None:
    pkg_src = Path(__file__).resolve().parent.parent / "src"
    env = os.environ.copy()
    env["PYTHONPATH"] = str(pkg_src)
    runner = CliRunner()
    with runner.isolated_workspace(
        {
            "tools/ok.py": (
                "from tasknest import tool\n"
                "@tool()\n"
                "def ok() -> None:\n"
                "    '''Pass.'''\n"
                "    print('SUBPROC_OK')\n"
            ),
            "tools/broken.py": (
                "from tasknest import ToolError, tool\n"
                "@tool()\n"
                "def broken() -> None:\n"
                "    '''Fail.'''\n"
                "    raise ToolError('subproc boom', exit_code=1)\n"
            ),
        }
    ) as workspace:
        pass_proc = subprocess.run(  # noqa: S603 - explicit python -m tasknest invocation
            [sys.executable, "-m", "tasknest", "--root", str(workspace), "run", "ok"],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        assert pass_proc.returncode == 0
        assert "SUBPROC_OK" in pass_proc.stdout

        fail_proc = subprocess.run(  # noqa: S603 - explicit python -m tasknest invocation
            [sys.executable, "-m", "tasknest", "--root", str(workspace), "run", "broken"],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        assert fail_proc.returncode == 1
        assert "subproc boom" in fail_proc.stderr

        usage_proc = subprocess.run(  # noqa: S603 - explicit python -m tasknest invocation
            [sys.executable, "-m", "tasknest", "--root", str(workspace), "run", "missing"],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
        assert usage_proc.returncode == 2
