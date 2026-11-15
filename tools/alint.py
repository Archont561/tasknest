"""Check repository policy via alint."""

from __future__ import annotations

from tasknest import ToolContext, tool


@tool(description="Check repository policy.")
def alint(ctx: ToolContext) -> None:
    """Check repository policy."""
    ctx.run(["alint", "check"])
