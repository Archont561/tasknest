"""Render and verify Jinja2-generated repository documentation."""

from __future__ import annotations

import difflib
from typing import TYPE_CHECKING

from jinja2 import Environment, FileSystemLoader, StrictUndefined
from tasknest import ToolError

if TYPE_CHECKING:
    from pathlib import Path

_DOCS = ("README.md", "AGENTS.md")
_UTF8 = "utf-8"


def _sync_doc(name: str, expected: str, root: Path, *, check_only: bool) -> bool:
    target = root / name
    actual = target.read_text(encoding=_UTF8) if target.exists() else ""
    if actual == expected:
        print(f"OK {name}")
        return True
    if check_only:
        diff = difflib.unified_diff(
            actual.splitlines(True),
            expected.splitlines(True),
            fromfile=name,
            tofile=f"generated/{name}",
        )
        print("".join(diff))
        return False
    target.write_text(expected, encoding=_UTF8)
    print(f"WROTE {name}")
    return True


def render_docs(root: Path, *, check_only: bool) -> None:
    """Render templates into README.md and AGENTS.md, or fail on drift."""
    env = Environment(
        loader=FileSystemLoader(root / "templates"),
        undefined=StrictUndefined,
        keep_trailing_newline=True,
        autoescape=False,
    )
    drifted = [
        name
        for name in _DOCS
        if not _sync_doc(name, env.get_template(f"{name}.j2").render(), root, check_only=check_only)
    ]
    if drifted:
        raise ToolError(f"Generated docs are out of date: {', '.join(drifted)}")
