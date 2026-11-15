"""Composite offline repository quality check task."""

from __future__ import annotations

from tasknest import tool


@tool(
    depends=[
        "alint",
        "sandbox_check",
        "format_check",
        "lint",
        "typecheck",
        "actions_check",
        "docs_check",
    ],
    description="Run offline-friendly repository quality checks.",
)
def check() -> None:
    """Run offline-friendly repository quality checks."""
