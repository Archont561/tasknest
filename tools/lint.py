"""Run Python, Gherkin, and TypeScript linters."""

from __future__ import annotations

from tasknest import ToolContext, tool


@tool(description="Run Python, Gherkin, and TypeScript linters.")
def lint(ctx: ToolContext) -> None:
    """Run Python, Gherkin, and TypeScript linters."""
    ctx.run(["ruff", "check", "tools", "packages/tasknest-py"])
    ctx.run(["rude", "check", "packages/tasknest-py/src", "tools"])
    ctx.run(["gherlint", "lint", "packages/tasknest-py/features"])
    ctx.run(
        ["bun", "x", "--bun", "--no-install", "biome", "lint", "packages/tasknest-ts", "apps/docs"]
    )
