"""Lint GitHub Actions workflows."""

from __future__ import annotations

from tasknest import ToolContext, tool


@tool(description="Lint GitHub Actions workflows.")
def actions_check(ctx: ToolContext) -> None:
    """Lint GitHub Actions workflows."""
    ctx.run(
        [
            "actionlint",
            ".github/workflows/ci.yml",
            ".github/workflows/pages.yml",
            ".github/workflows/publish-sandbox.yml",
            ".github/workflows/release.yml",
            ".github/workflows/relock.yml",
        ]
    )
