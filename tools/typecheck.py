"""Run Python and TypeScript type checks."""

from __future__ import annotations

from tasknest import ToolContext, tool


@tool(description="Run Python (mypy) and TypeScript (tsc) type checks.")
def typecheck(ctx: ToolContext) -> None:
    """Run Python (mypy) and TypeScript (tsc) type checks."""
    ctx.run(["mypy", "packages/tasknest-py", "tools"])
    ctx.run(
        ["bun", "x", "--bun", "--no-install", "tsc", "-p", "packages/tasknest-ts/tsconfig.json"]
    )
    ctx.run(["bun", "run", "--cwd", "apps/docs", "postinstall"])
    ctx.run(
        [
            "bun",
            "x",
            "--bun",
            "--no-install",
            "tsc",
            "-p",
            "apps/docs/tsconfig.json",
            "--noEmit",
        ]
    )
