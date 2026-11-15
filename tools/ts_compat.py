"""Build, pack, and verify TypeScript package compatibility."""

from __future__ import annotations

import sys
from pathlib import Path

from tasknest import ToolContext, ToolError, tool


@tool(description="Build, pack, and verify packages/tasknest-ts tarball compatibility.")
def ts_compat(ctx: ToolContext) -> None:
    """Build, pack, and verify packages/tasknest-ts tarball compatibility."""
    tools_dir = str(Path(__file__).resolve().parent)
    if tools_dir not in sys.path:
        sys.path.insert(0, tools_dir)
    from _ts_compat import verify_ts_compat

    if not verify_ts_compat(ctx.repo_root):
        raise ToolError("TypeScript package compatibility verification failed.")
