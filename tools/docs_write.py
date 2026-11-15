"""Generate repository documentation from Jinja2 templates."""

from __future__ import annotations

import sys
from pathlib import Path

from tasknest import ToolContext, tool


@tool(description="Generate documentation from templates.")
def docs_write(ctx: ToolContext) -> None:
    """Generate documentation from templates."""
    tools_dir = str(Path(__file__).resolve().parent)
    if tools_dir not in sys.path:
        sys.path.insert(0, tools_dir)
    from _docs import render_docs

    render_docs(ctx.repo_root, check_only=False)
