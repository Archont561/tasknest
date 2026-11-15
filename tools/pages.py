"""Render root README.md into dist/ for GitHub Pages."""

from __future__ import annotations

import sys
from pathlib import Path

from tasknest import ToolContext, ToolError, tool


@tool(description="Render root README.md into dist/ for GitHub Pages.")
def pages(ctx: ToolContext) -> None:
    """Render root README.md into dist/ for GitHub Pages."""
    tools_dir = str(Path(__file__).resolve().parent)
    if tools_dir not in sys.path:
        sys.path.insert(0, tools_dir)
    from _render_pages import render_pages

    if not render_pages(ctx.repo_root):
        raise ToolError("Failed to render GitHub Pages output.")
