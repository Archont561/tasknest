"""Tests for tasknest.cache opt-in caching, early cutoff, and local pickle."""

from __future__ import annotations

from typing import TYPE_CHECKING

from tasknest.discovery import discover_tasks
from tasknest.graph import RunOptions, run_plan

if TYPE_CHECKING:
    from pathlib import Path


def test_opt_in_cache_hit_miss_missing_output_and_force_bypass(tmp_path: Path) -> None:
    tools = tmp_path / "tools"
    tools.mkdir()
    (tmp_path / "input.txt").write_text("hello", encoding="utf-8")
    (tools / "build.py").write_text(
        "from pathlib import Path\n"
        "from tasknest import ToolContext, tool\n"
        "@tool(inputs=['input.txt'], outputs=['out.txt'], cache=True)\n"
        "def build(ctx: ToolContext) -> None:\n"
        "    count_file = Path(ctx.project_root) / 'runs.log'\n"
        "    prev = count_file.read_text('utf-8') if count_file.exists() else ''\n"
        "    count_file.write_text(prev + '1\\n', encoding='utf-8')\n"
        "    data = (Path(ctx.project_root) / 'input.txt').read_text('utf-8')\n"
        "    (Path(ctx.project_root) / 'out.txt').write_text(data.upper(), encoding='utf-8')\n"
        "    ctx.output({'upper': data.upper()})\n",
        encoding="utf-8",
    )
    registry = discover_tasks(tmp_path)

    r1 = run_plan(registry, "build", {})
    assert r1.exit_code == 0
    assert r1.succeeded == ("build",)
    assert (tmp_path / ".tasknest/cache").is_dir()

    r2 = run_plan(registry, "build", {})
    assert r2.exit_code == 0
    assert r2.skipped == ("build",)
    assert r2.task_records[0].cache_status == "hit"
    assert (tmp_path / "runs.log").read_text("utf-8").splitlines() == ["1"]

    (tmp_path / "out.txt").unlink()
    r3 = run_plan(registry, "build", {})
    assert r3.exit_code == 0
    assert r3.succeeded == ("build",)
    assert "missing declared output" in (r3.task_records[0].cache_reason or "")

    r4 = run_plan(registry, "build", {}, options=RunOptions(cache_mode="force"))
    assert r4.exit_code == 0
    assert r4.succeeded == ("build",)
    assert r4.task_records[0].cache_status == "bypassed"

    r5 = run_plan(registry, "build", {}, options=RunOptions(cache_mode="no_cache"))
    assert r5.exit_code == 0
    assert r5.succeeded == ("build",)
    assert r5.task_records[0].cache_status == "bypassed"


def test_early_cutoff_and_dynamic_env_tracking_and_pickle_output(tmp_path: Path) -> None:
    tools = tmp_path / "tools"
    tools.mkdir()
    (tmp_path / "meta.txt").write_text("v=1\ncomment=a\n", encoding="utf-8")
    (tools / "extract.py").write_text(
        "from pathlib import Path\n"
        "from tasknest import ToolContext, tool\n"
        "@tool(inputs=['meta.txt'], cache=True)\n"
        "def extract(ctx: ToolContext) -> None:\n"
        "    lines = (Path(ctx.project_root) / 'meta.txt').read_text('utf-8').splitlines()\n"
        "    ctx.output({'version': lines[0]})\n",
        encoding="utf-8",
    )
    (tools / "consume.py").write_text(
        "from pathlib import Path\n"
        "from tasknest import ToolContext, tool\n"
        "@tool(depends=['extract'], cache=True)\n"
        "def consume(ctx: ToolContext) -> None:\n"
        "    mode = ctx.env('BUILD_MODE', 'dev')\n"
        "    count_file = Path(ctx.project_root) / 'consume.log'\n"
        "    prev = count_file.read_text('utf-8') if count_file.exists() else ''\n"
        "    count_file.write_text(prev + f'{mode}\\n', encoding='utf-8')\n"
        "    ctx.output(('tuple_val', ctx.deps['extract']['version'], mode), format='pickle')\n",
        encoding="utf-8",
    )
    registry = discover_tasks(tmp_path)

    r1 = run_plan(registry, "consume", {})
    assert r1.exit_code == 0
    assert r1.succeeded == ("extract", "consume")

    (tmp_path / "meta.txt").write_text("v=1\ncomment=b\n", encoding="utf-8")
    r2 = run_plan(registry, "consume", {})
    assert r2.exit_code == 0
    assert r2.succeeded == ("extract",)
    assert r2.skipped == ("consume",)
    assert r2.committed_outputs["consume"] == ("tuple_val", "v=1", "dev")
    assert (tmp_path / "consume.log").read_text("utf-8").splitlines() == ["dev"]
