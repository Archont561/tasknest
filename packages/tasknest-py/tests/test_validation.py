"""Tests for strict structural validation, unknown marks, and mark filtering."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from tasknest.discovery import discover_tasks
from tasknest.errors import ValidationError
from tasknest.testing import CliRunner
from tasknest.validation import format_effect_summary, select_tasks_by_marks, validate_registry

if TYPE_CHECKING:
    from pathlib import Path


def test_strict_validation_rejects_unknown_marks_and_missing_description(tmp_path: Path) -> None:
    tools = tmp_path / "tools"
    tools.mkdir()
    (tmp_path / "tasknest.toml").write_text(
        "[tasknest]\nconfig_version = 1\n"
        "[checks]\nstrict = true\nrequire_description = true\nunknown_marks = 'error'\n"
        "[marks]\nfast = 'Fast check'\n",
        encoding="utf-8",
    )
    (tools / "good.py").write_text(
        "from tasknest import tool\n@tool(marks=['fast'])\ndef good() -> None:\n    '''Desc.'''\n",
        encoding="utf-8",
    )
    registry = discover_tasks(tmp_path)
    assert validate_registry(registry).warnings == ()

    (tools / "bad_mark.py").write_text(
        "from tasknest import tool\n@tool(marks=['typo'])\ndef bad() -> None:\n    '''Desc.'''\n",
        encoding="utf-8",
    )
    with pytest.raises(ValidationError, match="typo"):
        validate_registry(discover_tasks(tmp_path))

    (tools / "bad_mark.py").unlink()
    (tools / "no_desc.py").write_text(
        "from tasknest import tool\n@tool()\ndef no_desc() -> None:\n    pass\n",
        encoding="utf-8",
    )
    with pytest.raises(ValidationError, match="missing a required description"):
        validate_registry(discover_tasks(tmp_path))


def test_optional_test_and_feature_presence_checks(tmp_path: Path) -> None:
    tools = tmp_path / "tools"
    tools.mkdir()
    (tmp_path / "tasknest.toml").write_text(
        "[tasknest]\nconfig_version = 1\n[checks]\nrequire_tests = true\nrequire_features = true\n",
        encoding="utf-8",
    )
    (tools / "lint.py").write_text(
        "from tasknest import tool\n@tool()\ndef lint() -> None:\n    '''Lint.'''\n",
        encoding="utf-8",
    )
    with pytest.raises(ValidationError, match="missing required test file"):
        validate_registry(discover_tasks(tmp_path))

    (tools / "tests").mkdir()
    (tools / "tests/test_lint.py").write_text("", encoding="utf-8")
    with pytest.raises(ValidationError, match="missing required feature file"):
        validate_registry(discover_tasks(tmp_path))

    (tools / "features").mkdir()
    (tools / "features/lint.feature").write_text("Feature: lint\n", encoding="utf-8")
    assert validate_registry(discover_tasks(tmp_path)).warnings == ()


def test_unknown_marks_warn_mode_and_mark_filtering_with_prerequisites() -> None:
    runner = CliRunner()
    with runner.isolated_workspace(
        {
            "tasknest.toml": (
                "[tasknest]\nconfig_version = 1\n"
                "[checks]\nunknown_marks = 'warn'\n"
                "[marks]\nfast = 'Fast'\nwrites = 'Writes'\n"
            ),
            "tools/prep.py": (
                "from tasknest import tool\n"
                "@tool()\n"
                "def prep() -> None:\n"
                "    '''Prepare.'''\n"
                "    print('PREP_OK')\n"
            ),
            "tools/fmt.py": (
                "from tasknest import tool\n"
                "@tool(depends=['prep'], marks=['fast', 'writes', 'custom'])\n"
                "def fmt() -> None:\n"
                "    '''Format.'''\n"
                "    print('FMT_OK')\n"
            ),
        }
    ) as workspace:
        reg = discover_tasks(workspace)
        assert len(validate_registry(reg).warnings) == 1
        order = select_tasks_by_marks(reg, ["fast"])
        assert order == ("prep", "fmt")
        assert format_effect_summary(reg, order) == ["fmt: marks=fast,writes,custom"]

        res_check = CliRunner(workspace).invoke(["check"])
        assert res_check.exit_code == 0
        assert "custom" in res_check.stderr

        res_run = CliRunner(workspace).invoke(["run", "--mark", "fast"])
        assert res_run.exit_code == 0
        assert "effect: fmt: marks=fast,writes,custom" in res_run.stdout
        assert "PREP_OK" in res_run.stdout
        assert "FMT_OK" in res_run.stdout
