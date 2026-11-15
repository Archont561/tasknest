"""Tests for deterministic Jinja skill generation, drift check, and overwrite policy."""

from __future__ import annotations

import importlib.util

import pytest
from tasknest.discovery import discover_tasks
from tasknest.errors import ConfigError, ToolError
from tasknest.skill import check_skill, render_skill, write_skill
from tasknest.testing import CliRunner

HAS_JINJA2 = importlib.util.find_spec("jinja2") is not None


def test_skill_generation_drift_check_and_manual_overwrite_guard() -> None:
    runner = CliRunner()
    with runner.isolated_workspace(
        {
            "tasknest.toml": (
                "[tasknest]\nconfig_version = 1\n"
                "[skill]\noutput = '.agents/SKILL.md'\ncommand = 'pixi run tools'\n"
            ),
            "tools/z_last.py": (
                "from tasknest import tool\n"
                "@tool(marks=['fast'])\n"
                "def z_last() -> None:\n"
                "    '''Last task.'''\n"
            ),
            "tools/a_first.py": (
                "from tasknest import tool\n"
                "@tool(depends=['z_last'], requires=['ruff'])\n"
                "def a_first(fix: bool = False) -> None:\n"
                "    '''First task.'''\n"
            ),
        }
    ) as workspace:
        registry = discover_tasks(workspace)
        if not HAS_JINJA2:
            with pytest.raises(ConfigError, match="tasknest\\[skill\\]"):
                render_skill(registry)
            return

        rendered_1 = render_skill(registry)
        rendered_2 = render_skill(registry)
        assert rendered_1 == rendered_2
        assert "pixi run tools run a_first" in rendered_1
        assert "First task." in rendered_1
        assert rendered_1.index("a_first") < rendered_1.index("z_last")

        assert check_skill(registry) is False
        manual_target = workspace / ".agents/SKILL.md"
        manual_target.parent.mkdir(parents=True, exist_ok=True)
        manual_target.write_text("# Custom manual skill\n", encoding="utf-8")

        # Drift check does not modify existing file
        assert check_skill(registry) is False
        assert manual_target.read_text(encoding="utf-8") == "# Custom manual skill\n"

        # Writing over manual file without force fails closed
        with pytest.raises(ToolError, match="--force"):
            write_skill(registry)
        assert manual_target.read_text(encoding="utf-8") == "# Custom manual skill\n"

        # Force overwrites and subsequent check passes
        write_skill(registry, force=True)
        assert check_skill(registry) is True
        res = CliRunner(workspace).invoke(["skill", "--check"])
        assert res.exit_code == 0
