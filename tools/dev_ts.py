"""Run the tasknest-ts watch builder."""

from __future__ import annotations

from tasknest import ToolContext, tool


@tool(
    marks=["dev"],
    requires=["bun"],
    persistent=True,
    description="Watch and rebuild packages/tasknest-ts.",
)
def dev_ts(ctx: ToolContext) -> None:
    """Watch and rebuild packages/tasknest-ts."""
    ctx.run(["bun", "run", "--cwd", "packages/tasknest-ts", "dev"])
