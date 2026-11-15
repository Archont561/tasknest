"""Check generated documentation against Jinja2 templates."""

from __future__ import annotations

import sys
from pathlib import Path

from tasknest import ToolContext, tool


@tool(description="Check generated documentation.")
def docs_check(ctx: ToolContext) -> None:
    """Check generated documentation."""
    tools_dir = str(Path(__file__).resolve().parent)
    if tools_dir not in sys.path:
        sys.path.insert(0, tools_dir)
    from _docs import render_docs

    render_docs(ctx.repo_root, check_only=True)
