"""Build static Fumadocs documentation into dist/ for GitHub Pages."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

_UTF8 = "utf-8"


def _resolve_base_path(repo: str | None, base_path: str | None) -> str:
    if base_path is not None:
        return base_path
    env_base = os.environ.get("NEXT_PUBLIC_BASE_PATH")
    if env_base is not None:
        return env_base
    resolved_repo = repo or os.environ.get("GITHUB_REPOSITORY") or "Archont561/tasknest"
    repo_name = resolved_repo.split("/")[-1].strip()
    return f"/{repo_name}" if repo_name else ""


def render_pages(
    root: Path,
    out_dir: Path | None = None,
    repo: str | None = None,
    base_path: str | None = None,
) -> bool:
    """Build apps/docs static export and copy it into dist/ with .nojekyll."""
    docs_dir = root / "apps" / "docs"
    export_dir = docs_dir / "out"
    target_dir = out_dir or (root / "dist")
    resolved_base = _resolve_base_path(repo, base_path)

    env = dict(os.environ)
    env["NEXT_PUBLIC_BASE_PATH"] = resolved_base
    env["NEXT_TELEMETRY_DISABLED"] = "1"

    subprocess.run(["bun", "run", "--cwd", str(docs_dir), "postinstall"], env=env, check=True)
    subprocess.run(["bun", "run", "--cwd", str(docs_dir), "build"], env=env, check=True)

    if not export_dir.is_dir():
        return False

    if target_dir.exists():
        shutil.rmtree(target_dir)
    shutil.copytree(export_dir, target_dir)
    (target_dir / ".nojekyll").write_text("", encoding=_UTF8)
    print(f"WROTE {target_dir / 'index.html'} (basePath={resolved_base or '/'})")
    return True


if __name__ == "__main__":
    raise SystemExit(0 if render_pages(Path(__file__).resolve().parent.parent) else 1)
