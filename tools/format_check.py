"""Check Python and TypeScript formatting."""

from __future__ import annotations

from tasknest import ToolContext, tool


@tool(description="Check Python and TypeScript formatting.")
def format_check(ctx: ToolContext) -> None:
    """Check Python and TypeScript formatting."""
    ctx.run(["ruff", "format", "--check", "tools", "packages/tasknest-py"])
    ctx.run(["bun", "x", "--bun", "--no-install", "biome", "format", "packages/tasknest-ts"])
