"""Run Python, Gherkin, and TypeScript linters."""

from __future__ import annotations

from tasknest import ToolContext, tool


@tool(description="Run Python, Gherkin, and TypeScript linters.")
def lint(ctx: ToolContext) -> None:
    """Run Python, Gherkin, and TypeScript linters."""
    ctx.run(["ruff", "check", "tools", "packages/python"])
    ctx.run(["rude", "check", "packages/python/src", "tools"])
    ctx.run(["gherlint", "lint", "packages/python/features"])
    ctx.run(["bun", "x", "--bun", "--no-install", "biome", "lint", "packages/tasknest"])
