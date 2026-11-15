"""Verify release tag, main-branch ancestry, and manifest versions."""

from __future__ import annotations

import json
import os
from typing import TYPE_CHECKING

import tomllib  # type: ignore[import-not-found]  # tools run under Pixi Python >=3.12
from tasknest import ToolContext, ToolError, tool

if TYPE_CHECKING:
    from pathlib import Path


def _resolve_release_tag(tag: str) -> str:
    if tag:
        resolved = tag
    elif os.environ.get("GITHUB_REF_TYPE") == "tag":
        resolved = os.environ.get("GITHUB_REF_NAME", "")
    else:
        raise ToolError("Release workflow must run on a v* tag or with --tag set.")
    if not resolved.startswith("v"):
        raise ToolError(f"Release tag '{resolved}' must start with 'v'.")
    return resolved


def _verify_manifest_versions(repo_root: Path, release_tag: str) -> None:
    expected = release_tag.removeprefix("v")
    pyproject = tomllib.loads((repo_root / "packages/python/pyproject.toml").read_text("utf-8"))
    pkg = json.loads((repo_root / "packages/tasknest/package.json").read_text("utf-8"))
    py_name = pyproject["project"]["name"]
    ts_name = pkg["name"]
    if py_name != "tasknest" or ts_name != "@archont561/tasknest":
        raise ToolError(f"Unexpected package names: python={py_name!r}, npm={ts_name!r}")
    py_ver = pyproject["project"]["version"]
    ts_ver = pkg["version"]
    if py_ver.replace(".dev", "-dev.") != expected or ts_ver != expected:
        raise ToolError(
            f"Tag version {expected} does not match manifests (python={py_ver}, npm={ts_ver})."
        )


@tool(description="Verify release tag ancestry and package manifest versions.")
def release_check(ctx: ToolContext, tag: str = "") -> None:
    """Verify release tag, main-branch ancestry, and package versions."""
    resolved = _resolve_release_tag(tag)
    ctx.run(["git", "merge-base", "--is-ancestor", "HEAD", "origin/main"])
    _verify_manifest_versions(ctx.repo_root, resolved)
