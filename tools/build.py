"""Build Python and TypeScript distribution artifacts."""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

from tasknest import ToolContext, ToolError, tool


@tool(description="Build Python and TypeScript distribution artifacts.")
def build(ctx: ToolContext, out_dir: Path = Path("dist/release")) -> None:
    """Build Python wheel/sdist and TypeScript tarball into out_dir."""
    target = out_dir if out_dir.is_absolute() else (ctx.repo_root / out_dir)
    pypi_dir = target / "pypi"
    npm_dir = target / "npm"
    for directory in (pypi_dir, npm_dir):
        if directory.exists():
            shutil.rmtree(directory)
        directory.mkdir(parents=True, exist_ok=True)
    ctx.run(
        [sys.executable, "-m", "hatchling", "build", "-d", str(pypi_dir)],
        cwd=Path("packages/python"),
    )
    ctx.run(["bun", "pm", "pack", "--cwd", "packages/tasknest", "--destination", str(npm_dir)])
    tarballs = list(npm_dir.glob("*.tgz"))
    if len(tarballs) != 1:
        raise ToolError(f"Expected 1 npm tarball in {npm_dir}, found {len(tarballs)}.")
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with Path(github_output).open("a", encoding="utf-8") as handle:
            handle.write(f"npm-tarball={tarballs[0].name}\n")
