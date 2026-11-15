"""Tests for tasknest.affected change context and conservative selection."""

from __future__ import annotations

import shutil
import subprocess
from typing import TYPE_CHECKING

import pytest
from tasknest.affected import (
    AffectedContext,
    ChangedFile,
    SelectionPolicy,
    collect_git_changes,
    parse_git_name_status,
    select_conservative_targets,
)
from tasknest.discovery import discover_tasks
from tasknest.errors import ToolError
from tasknest.graph import RunOptions, run_plan

if TYPE_CHECKING:
    from pathlib import Path


def test_parse_git_name_status_represents_renames_deletions_and_untracked() -> None:
    raw_diff = "M\tsrc/app.py\nR100\tsrc/old.py\tsrc/new.py\nD\tsrc/gone.py\n"
    raw_untracked = "tests/test_extra.py\n"
    files = parse_git_name_status(raw_diff, raw_untracked)
    assert files == (
        ChangedFile(path="src/app.py", status="modified", old_path=None),
        ChangedFile(path="src/new.py", status="renamed", old_path="src/old.py"),
        ChangedFile(path="src/gone.py", status="deleted", old_path="src/gone.py"),
        ChangedFile(path="tests/test_extra.py", status="untracked", old_path=None),
    )
    ctx = AffectedContext(
        available=True, complete=True, files=files, base_ref="main", target_ref="WORKTREE"
    )
    assert "src/old.py" in ctx.all_touched_paths()
    assert "src/new.py" in ctx.all_touched_paths()
    assert "src/gone.py" in ctx.all_touched_paths()


def test_collect_git_changes_explicit_unavailable_outside_git(tmp_path: Path) -> None:
    ctx = collect_git_changes(tmp_path, base_ref="HEAD")
    assert ctx.available is False
    assert ctx.complete is False
    assert ctx.reason is not None


def _git(cwd: Path, *args: str) -> None:
    git = shutil.which("git")
    assert git is not None
    subprocess.run([git, *args], cwd=cwd, check=True, capture_output=True)  # noqa: S603


def test_collect_git_changes_real_git_repo_base_and_worktree(tmp_path: Path) -> None:
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.email", "test@example.com")
    _git(tmp_path, "config", "user.name", "Test")
    (tmp_path / "a.py").write_text("x = 1\n", encoding="utf-8")
    (tmp_path / "b.py").write_text("y = 1\n", encoding="utf-8")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "init")

    (tmp_path / "a.py").write_text("x = 2\n", encoding="utf-8")
    (tmp_path / "b.py").unlink()
    (tmp_path / "new.py").write_text("z = 1\n", encoding="utf-8")

    ctx = collect_git_changes(tmp_path, base_ref="HEAD")
    assert ctx.available is True
    assert ctx.complete is True
    assert ctx.base_ref == "HEAD"
    assert ctx.target_ref == "WORKTREE"
    statuses = {entry.path: entry.status for entry in ctx.files}
    assert statuses["a.py"] == "modified"
    assert statuses["b.py"] == "deleted"
    assert statuses["new.py"] == "untracked"


def test_conservative_selection_handles_renames_globals_strict_and_force_all() -> None:
    mapping = {"src/a.py": ["tests/test_a.py"], "src/b.py": ["tests/test_b.py"]}
    narrowed = select_conservative_targets(
        [ChangedFile(path="src/a.py", status="modified")],
        mapping,
    )
    assert narrowed.targets == ("tests/test_a.py",)
    assert narrowed.fallback_reason is None

    unmapped_rename = select_conservative_targets(
        [ChangedFile(path="src/a.py", status="renamed", old_path="src/old_unmapped.py")],
        mapping,
    )
    assert unmapped_rename.targets == ("tests",)
    assert unmapped_rename.fallback_reason is not None
    assert "src/old_unmapped.py" in unmapped_rename.fallback_reason

    global_change = select_conservative_targets(["pixi.lock"], mapping)
    assert global_change.targets == ("tests",)
    assert "global trigger" in (global_change.fallback_reason or "")

    forced = select_conservative_targets(
        [ChangedFile(path="src/a.py", status="modified")],
        mapping,
        SelectionPolicy(force_all=True),
    )
    assert forced.targets == ("tests",)
    assert "forced" in (forced.fallback_reason or "")

    with pytest.raises(ToolError, match="unmapped"):
        select_conservative_targets(
            ["src/unknown.py"],
            mapping,
            SelectionPolicy(strict=True),
        )


def test_import_graph_cached_output_feeds_downstream_selector(tmp_path: Path) -> None:
    src = tmp_path / "src/pkg"
    tests = tmp_path / "tests"
    tools = tmp_path / "tools"
    src.mkdir(parents=True)
    tests.mkdir(parents=True)
    tools.mkdir(parents=True)
    (src / "__init__.py").write_text("", encoding="utf-8")
    (src / "alpha.py").write_text("VALUE = 1\n", encoding="utf-8")
    (tests / "test_alpha.py").write_text("from pkg.alpha import VALUE\n", encoding="utf-8")

    (tools / "graph_map.py").write_text(
        "from tasknest import ToolContext, build_python_reverse_map, tool\n"
        "@tool(inputs=['src/**/*.py', 'tests/test_*.py'], cache=True)\n"
        "def graph_map(ctx: ToolContext) -> None:\n"
        "    root = ctx.repo_root\n"
        "    mapping = build_python_reverse_map(root, root / 'src', root / 'tests')\n"
        "    ctx.output(mapping)\n",
        encoding="utf-8",
    )
    (tools / "test_affected.py").write_text(
        "from tasknest import ToolContext, select_conservative_targets, tool\n"
        "@tool(depends=['graph_map'])\n"
        "def test_affected(ctx: ToolContext) -> None:\n"
        "    plan = select_conservative_targets(ctx.affected, ctx.deps['graph_map'])\n"
        "    ctx.output({'targets': list(plan.targets), 'reason': plan.fallback_reason})\n",
        encoding="utf-8",
    )

    registry = discover_tasks(tmp_path)
    affected = AffectedContext(
        available=True,
        complete=True,
        files=(ChangedFile(path="src/pkg/alpha.py", status="modified"),),
    )
    report1 = run_plan(registry, "test_affected", {}, options=RunOptions(affected=affected))
    assert report1.exit_code == 0
    assert report1.committed_outputs["test_affected"] == {
        "targets": ["tests/test_alpha.py"],
        "reason": None,
    }

    report2 = run_plan(registry, "test_affected", {}, options=RunOptions(affected=affected))
    assert report2.exit_code == 0
    assert "graph_map" in report2.skipped
    assert report2.committed_outputs["test_affected"] == {
        "targets": ["tests/test_alpha.py"],
        "reason": None,
    }
