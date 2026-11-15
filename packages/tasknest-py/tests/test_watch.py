"""Tests for tasknest.watch DAG-aware watch mode and early cutoff."""

from __future__ import annotations

from typing import TYPE_CHECKING

from tasknest.discovery import discover_tasks
from tasknest.watch import WatchConfig, WatchSession

if TYPE_CHECKING:
    from pathlib import Path


def test_watch_ignores_self_outputs_and_uses_early_cutoff(tmp_path: Path) -> None:
    tools = tmp_path / "tools"
    tools.mkdir()
    (tmp_path / "pyproject.toml").write_text("[project]\nversion = '0.2.0'\n", encoding="utf-8")
    (tmp_path / "side.txt").write_text("side-1\n", encoding="utf-8")

    (tools / "read_ver.py").write_text(
        "from pathlib import Path\n"
        "from tasknest import ToolContext, tool\n"
        "@tool(inputs=['pyproject.toml'], outputs=['ver.txt'], cache=True)\n"
        "def read_ver(ctx: ToolContext) -> None:\n"
        "    text = (Path(ctx.project_root) / 'pyproject.toml').read_text('utf-8')\n"
        "    for line in text.splitlines():\n"
        "        if line.startswith('version'):\n"
        "            ver = line.split('=')[1].strip().strip(\"'\")\n"
        "    (Path(ctx.project_root) / 'ver.txt').write_text(ver, encoding='utf-8')\n"
        "    ctx.output({'version': ver})\n",
        encoding="utf-8",
    )
    (tools / "side_task.py").write_text(
        "from pathlib import Path\n"
        "from tasknest import ToolContext, tool\n"
        "@tool(inputs=['side.txt'], cache=True)\n"
        "def side_task(ctx: ToolContext) -> None:\n"
        "    data = (Path(ctx.project_root) / 'side.txt').read_text('utf-8').strip()\n"
        "    ctx.output({'side': data})\n",
        encoding="utf-8",
    )
    (tools / "downstream.py").write_text(
        "from pathlib import Path\n"
        "from tasknest import ToolContext, tool\n"
        "@tool(depends=['read_ver', 'side_task'], cache=True)\n"
        "def downstream(ctx: ToolContext) -> None:\n"
        "    log = Path(ctx.project_root) / 'downstream.log'\n"
        "    prev = log.read_text('utf-8') if log.exists() else ''\n"
        "    log.write_text(prev + ctx.deps['read_ver']['version'] + '\\n', encoding='utf-8')\n",
        encoding="utf-8",
    )

    registry = discover_tasks(tmp_path)
    session = WatchSession(
        registry=registry,
        target_name="downstream",
        config=WatchConfig(interval_ms=10, max_cycles=1),
    )

    init_cycle = session.run_initial()
    assert init_cycle.report.exit_code == 0
    assert init_cycle.report.succeeded == ("read_ver", "side_task", "downstream")

    # Writing only to declared outputs or without input changes must not trigger work.
    assert session.step() is None

    # Editing pyproject.toml without changing version triggers read_ver, early-cuts off downstream,
    # and keeps clean branch side_task skipped_clean!
    (tmp_path / "pyproject.toml").write_text(
        "[project]\n# comment only\nversion = '0.2.0'\n", encoding="utf-8"
    )
    c2 = session.step()
    assert c2 is not None
    assert c2.dirty_tasks == ("read_ver", "downstream")
    assert c2.skipped_clean == ("side_task",)
    assert c2.report.succeeded == ("read_ver",)
    assert c2.report.skipped == ("downstream",)
    assert (tmp_path / "downstream.log").read_text("utf-8").splitlines() == ["0.2.0"]

    # Changing the version actually re-runs downstream.
    (tmp_path / "pyproject.toml").write_text("[project]\nversion = '0.3.0'\n", encoding="utf-8")
    c3 = session.step()
    assert c3 is not None
    assert c3.report.succeeded == ("read_ver", "downstream")
    assert (tmp_path / "downstream.log").read_text("utf-8").splitlines() == ["0.2.0", "0.3.0"]
