"""Check generated pixi-sandbox workflows and restore launcher."""

from __future__ import annotations

from tasknest import ToolContext, tool


@tool(description="Check generated pixi-sandbox workflows and restore launcher.")
def sandbox_check(ctx: ToolContext) -> None:
    """Check generated pixi-sandbox workflows and restore launcher."""
    ctx.run(["pixi-sandbox", "init", "--script-path", "scripts/restore.sh", "--check"])
