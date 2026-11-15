"""Run Python and TypeScript test suites."""

from __future__ import annotations

import os
import sys

from tasknest import ToolContext, tool


@tool(description="Run Python and TypeScript tests.")
def test(ctx: ToolContext) -> None:
    """Run Python and TypeScript tests."""
    py_src = str(ctx.repo_root / "packages/python/src")
    existing = os.environ.get("PYTHONPATH", "")
    pythonpath = os.pathsep.join([py_src, existing]) if existing else py_src
    ctx.run(
        [sys.executable, "-m", "pytest", "packages/python/tests"],
        env={"PYTHONPATH": pythonpath},
    )
    ctx.run(["bun", "test", "--coverage", "packages/tasknest/tests"])
