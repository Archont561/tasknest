"""Repository automation via doit, pending the Tasknest runner."""

from __future__ import annotations

import difflib
import os
import subprocess
import sys
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined

ROOT = Path(__file__).resolve().parent.parent
DOIT_CONFIG = {"default_tasks": ["check"], "verbosity": 2, "dep_file": str(ROOT / ".doit.db")}


def _command(*argv: str) -> bool:
    """Run argv without a shell; return False on failure for doit."""
    print("+ " + " ".join(argv), flush=True)
    return subprocess.run(argv, cwd=ROOT, check=False).returncode == 0


def _action(*argv: str) -> dict:
    return {"actions": [(_command, argv)], "uptodate": [False]}


def _render(check: bool) -> bool:
    env = Environment(
        loader=FileSystemLoader(ROOT / "templates"),
        undefined=StrictUndefined,
        keep_trailing_newline=True,
        autoescape=False,
    )
    success = True
    for name in ("README.md", "AGENTS.md"):
        expected = env.get_template(name + ".j2").render()
        target = ROOT / name
        actual = target.read_text(encoding="utf-8") if target.exists() else ""
        if actual == expected:
            print(f"OK {name}")
        elif check:
            success = False
            print(
                "".join(
                    difflib.unified_diff(
                        actual.splitlines(True),
                        expected.splitlines(True),
                        fromfile=name,
                        tofile=f"generated/{name}",
                    )
                )
            )
        else:
            target.write_text(expected, encoding="utf-8")
            print(f"WROTE {name}")
    return success


def _test_python() -> bool:
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(
        [str(ROOT / "packages/python/src"), env.get("PYTHONPATH", "")]
    )
    cmd = [sys.executable, "-m", "pytest", "packages/python/tests"]
    print("+ " + " ".join(cmd), flush=True)
    return subprocess.run(cmd, cwd=ROOT, env=env, check=False).returncode == 0


def task_alint() -> dict:
    """Check repository policy."""
    return _action("alint", "check")


def task_sandbox_check() -> dict:
    """Check generated pixi-sandbox workflows and restore launcher."""
    return _action("pixi-sandbox", "init", "--script-path", "scripts/restore.sh", "--check")


def task_format_check() -> dict:
    """Check Python formatting."""
    return _action("ruff", "format", "--check", "tools/dodo.py", "packages/python")


def task_lint() -> dict:
    """Run Python linters."""
    return {
        "actions": [
            (_command, ("ruff", "check", "tools/dodo.py", "packages/python")),
            (_command, ("rude", "check", "packages/python/src")),
        ],
        "uptodate": [False],
    }


def task_actions_check() -> dict:
    """Lint GitHub Actions workflows."""
    return _action(
        "actionlint",
        ".github/workflows/ci.yml",
        ".github/workflows/publish-sandbox.yml",
        ".github/workflows/relock.yml",
    )


def task_docs_check() -> dict:
    """Check generated documentation."""
    return {"basename": "docs-check", "actions": [(_render, (True,))], "uptodate": [False]}


def task_docs_write() -> dict:
    """Generate documentation from templates."""
    return {"basename": "docs-write", "actions": [(_render, (False,))], "uptodate": [False]}


def task_test() -> dict:
    """Run Python and TypeScript tests."""
    return {
        "actions": [_test_python, (_command, ("bun", "test", "packages/tasknest/tests"))],
        "uptodate": [False],
    }


def task_check() -> dict:
    """Run offline-friendly repository quality checks."""
    return {
        "actions": None,
        "task_dep": [
            "alint",
            "sandbox_check",
            "format_check",
            "lint",
            "actions_check",
            "docs-check",
        ],
        "uptodate": [False],
    }
