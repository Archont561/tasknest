"""Build and verify Python wheel and sdist compatibility."""

from __future__ import annotations

import sys
from pathlib import Path

from tasknest import ToolContext, ToolError, tool


@tool(description="Build and verify packages/tasknest-py wheel and sdist compatibility.")
def py_compat(ctx: ToolContext) -> None:
    """Build and verify packages/tasknest-py wheel and sdist compatibility."""
    tools_dir = str(Path(__file__).resolve().parent)
    if tools_dir not in sys.path:
        sys.path.insert(0, tools_dir)
    from _py_compat import verify_py_compat

    if not verify_py_compat(ctx.repo_root):
        raise ToolError("Python package compatibility verification failed.")
