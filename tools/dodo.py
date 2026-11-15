"""Repository automation via doit, pending the Tasknest runner."""

from __future__ import annotations

import difflib
import os
import subprocess
import sys
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined

ROOT = Path(__file__).resolve().parent.parent
_CHECK = "check"
_LINT = "lint"
_PYTHON_TARGETS = ("tools", "packages/python")
_BUN_X = ("bun", "x", "--bun", "--no-install")
DOIT_CONFIG = {"default_tasks": [_CHECK], "verbosity": 2, "dep_file": str(ROOT / ".doit.db")}


def _command(*argv: str) -> bool:
    """Run argv without a shell; return False on failure for doit."""
    print("+ " + " ".join(argv), flush=True)
    return subprocess.run(argv, cwd=ROOT, check=False).returncode == 0


def _tasks(*items: object, basename: str | None = None) -> dict[str, object]:
    task: dict[str, object] = {"actions": list(items), "uptodate": [False]}
    if basename is not None:
        task["basename"] = basename
    return task


def _action(*argv: str) -> dict[str, object]:
    return _tasks((_command, argv))


def _render(check_only: bool) -> bool:
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
        elif check_only:
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


def _pages() -> bool:
    tools_dir = str(Path(__file__).resolve().parent)
    if tools_dir not in sys.path:
        sys.path.insert(0, tools_dir)
    from _render_pages import render_pages

    return render_pages(ROOT)


def _ts_compat() -> bool:
    tools_dir = str(Path(__file__).resolve().parent)
    if tools_dir not in sys.path:
        sys.path.insert(0, tools_dir)
    from _ts_compat import verify_ts_compat

    return verify_ts_compat(ROOT)


def _py_compat() -> bool:
    tools_dir = str(Path(__file__).resolve().parent)
    if tools_dir not in sys.path:
        sys.path.insert(0, tools_dir)
    from _py_compat import verify_py_compat

    return verify_py_compat(ROOT)


def task_alint() -> dict[str, object]:
    """Check repository policy."""
    return _action("alint", _CHECK)


def task_sandbox_check() -> dict[str, object]:
    """Check generated pixi-sandbox workflows and restore launcher."""
    return _action("pixi-sandbox", "init", "--script-path", "scripts/restore.sh", "--check")


def task_format_check() -> dict[str, object]:
    """Check Python and TypeScript formatting."""
    return _tasks(
        (_command, ("ruff", "format", "--check", *_PYTHON_TARGETS)),
        (_command, (*_BUN_X, "biome", "format", "packages/tasknest")),
    )


def task_lint() -> dict[str, object]:
    """Run Python, Gherkin, and TypeScript linters."""
    return _tasks(
        (_command, ("ruff", _CHECK, *_PYTHON_TARGETS)),
        (_command, ("rude", _CHECK, "packages/python/src", "tools")),
        (_command, ("gherlint", _LINT, "packages/python/features")),
        (_command, (*_BUN_X, "biome", _LINT, "packages/tasknest")),
    )


def task_typecheck() -> dict[str, object]:
    """Run Python (mypy) and TypeScript (tsc) type checks."""
    return _tasks(
        (_command, ("mypy", *_PYTHON_TARGETS[::-1])),
        (_command, (*_BUN_X, "tsc", "-p", "packages/tasknest/tsconfig.json")),
    )


def task_actions_check() -> dict[str, object]:
    """Lint GitHub Actions workflows."""
    return _action(
        "actionlint",
        ".github/workflows/ci.yml",
        ".github/workflows/pages.yml",
        ".github/workflows/publish-sandbox.yml",
        ".github/workflows/relock.yml",
    )


def task_docs_check() -> dict[str, object]:
    """Check generated documentation."""
    return _tasks((_render, (True,)), basename="docs-check")


def task_docs_write() -> dict[str, object]:
    """Generate documentation from templates."""
    return _tasks((_render, (False,)), basename="docs-write")


def task_pages() -> dict[str, object]:
    """Render root README.md into dist/ for GitHub Pages."""
    return _tasks(_pages)


def task_py_compat() -> dict[str, object]:
    """Build and verify packages/python wheel and sdist compatibility."""
    return _tasks(_py_compat, basename="py-compat")


def task_ts_compat() -> dict[str, object]:
    """Build, pack, and verify packages/tasknest tarball compatibility."""
    return _tasks(_ts_compat, basename="ts-compat")


def task_test() -> dict[str, object]:
    """Run Python and TypeScript tests."""
    return _tasks(
        _test_python,
        (_command, ("bun", "test", "--coverage", "packages/tasknest/tests")),
    )


def task_check() -> dict[str, object]:
    """Run offline-friendly repository quality checks."""
    return {
        "actions": None,
        "task_dep": [
            "alint",
            "sandbox_check",
            "format_check",
            "lint",
            "typecheck",
            "actions_check",
            "docs-check",
        ],
        "uptodate": [False],
    }
