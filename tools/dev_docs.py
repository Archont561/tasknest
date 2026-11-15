"""Run the Fumadocs Next.js development server."""

from __future__ import annotations

from tasknest import ToolContext, tool


@tool(
    marks=["dev"],
    requires=["bun"],
    persistent=True,
    description="Start the Fumadocs documentation dev server.",
)
def dev_docs(ctx: ToolContext) -> None:
    """Start the Fumadocs documentation dev server."""
    ctx.run(["bun", "run", "--cwd", "apps/docs", "dev"])
