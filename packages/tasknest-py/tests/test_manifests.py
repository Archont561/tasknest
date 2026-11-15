"""Tests for Tier-1 manifest task discovery, Tier-2 overrides, and package CLI filtering."""

from __future__ import annotations

import json
import sys
from typing import TYPE_CHECKING

import pytest
from tasknest.discovery import discover_tasks
from tasknest.errors import ConfigError, DiscoveryError, ValidationError
from tasknest.testing import CliRunner
from tasknest.validation import validate_registry

if TYPE_CHECKING:
    from pathlib import Path


def test_package_json_and_pyproject_discovery_with_workspaces(tmp_path: Path) -> None:
    (tmp_path / "tasknest.toml").write_text(
        "[tasknest]\nconfig_version = 1\n\n[discovery]\nworkspaces = true\n\n"
        '[[discovery.manifests]]\npath = "services/*"\n'
        'persistent_scripts = ["serve"]\nexclude_scripts = ["skip_me"]\n\n'
        "[checks]\nstrict = true\nrequire_description = true\n"
        'require_tests = true\nrequire_features = true\nunknown_marks = "error"\n\n'
        '[marks]\nfast = "Fast"\ndev = "Dev"\n',
        encoding="utf-8",
    )
    (tmp_path / "package.json").write_text(
        json.dumps({"name": "mono", "workspaces": ["apps/*"]}), encoding="utf-8"
    )
    (tmp_path / "bun.lock").write_text("", encoding="utf-8")

    web_dir = tmp_path / "apps" / "web"
    web_dir.mkdir(parents=True)
    (web_dir / "package.json").write_text(
        json.dumps(
            {
                "name": "@mono/web",
                "scripts": {"build": "echo web-build", "lint": "echo web-lint"},
                "tasknest": {
                    "tasks": {
                        "lint": {"marks": ["fast"], "depends": ["build"]},
                        "dev": {"cmd": ["echo", "dev"], "persistent": True, "marks": ["dev"]},
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    api_dir = tmp_path / "services" / "api"
    api_dir.mkdir(parents=True)
    (api_dir / "pyproject.toml").write_text(
        "[tool.tasknest.tasks]\n"
        'lint = { cmd = ["python3", "-c", "print(\'API_LINT\')"], marks = ["fast"] }\n'
        'serve = ["python3", "-c", "print(\'API_SERVE\')"]\n'
        'skip_me = ["echo", "nope"]\n',
        encoding="utf-8",
    )

    reg = discover_tasks(tmp_path)
    assert sorted(reg.tasks) == [
        "api.lint",
        "api.serve",
        "web.build",
        "web.dev",
        "web.lint",
    ]
    assert reg.tasks["web.lint"].depends == ("web.build",)
    assert reg.tasks["web.lint"].is_manifest is True
    assert reg.tasks["web.lint"].package_name == "web"
    assert reg.tasks["api.serve"].persistent is True
    assert reg.tasks["web.dev"].persistent is True
    validate_registry(reg)


def test_tier2_file_overrides_manifest_and_duplicate_files_still_fail(tmp_path: Path) -> None:
    (tmp_path / "tasknest.toml").write_text(
        "[tasknest]\nconfig_version = 1\n\n"
        '[[discovery.roots]]\npath = "tools"\n\n'
        '[[discovery.manifests]]\npath = "apps/*"\n',
        encoding="utf-8",
    )
    web_dir = tmp_path / "apps" / "web"
    web_dir.mkdir(parents=True)
    (web_dir / "package.json").write_text(
        json.dumps(
            {
                "scripts": {"build": "echo manifest-build", "test": "echo manifest-test"},
                "tasknest": {"tasks": {"test": {"depends": ["build"]}}},
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "tools" / "web").mkdir(parents=True)
    (tmp_path / "tools" / "web" / "build.py").write_text(
        "from tasknest import tool\n\n"
        '@tool(description="Tier-2 build override.")\n'
        "def build() -> None:\n"
        '    print("TIER2_OVERRIDE_RAN")\n',
        encoding="utf-8",
    )

    reg = discover_tasks(tmp_path)
    assert reg.tasks["web.build"].is_manifest is False
    assert reg.tasks["web.build"].package_name == "web"
    assert reg.tasks["web.test"].depends == ("web.build",)

    res = CliRunner(tmp_path).invoke(["run", "-p", "web", "build"])
    assert res.exit_code == 0
    assert "TIER2_OVERRIDE_RAN" in res.stdout
    assert "manifest-build" not in res.stdout

    # Duplicate Tier-2 file across two roots must still fail.
    (tmp_path / "tasknest.toml").write_text(
        "[tasknest]\nconfig_version = 1\n\n"
        '[[discovery.roots]]\npath = "tools"\n\n'
        '[[discovery.roots]]\npath = "extra"\n',
        encoding="utf-8",
    )
    (tmp_path / "extra" / "web").mkdir(parents=True)
    (tmp_path / "extra" / "web" / "build.py").write_text(
        "from tasknest import tool\n\n@tool()\ndef build() -> None:\n    pass\n",
        encoding="utf-8",
    )
    with pytest.raises(DiscoveryError, match="Duplicate task name"):
        discover_tasks(tmp_path)


def test_lockfile_runner_detection(tmp_path: Path) -> None:
    (tmp_path / "tasknest.toml").write_text(
        '[tasknest]\nconfig_version = 1\n\n[[discovery.manifests]]\npath = "apps/*"\n',
        encoding="utf-8",
    )
    for name, lockfile in (
        ("p1", "pnpm-lock.yaml"),
        ("p2", "yarn.lock"),
        ("p3", "package-lock.json"),
    ):
        d = tmp_path / "apps" / name
        d.mkdir(parents=True)
        (d / lockfile).write_text("", encoding="utf-8")
        (d / "package.json").write_text(json.dumps({"scripts": {"lint": "true"}}), encoding="utf-8")

    # Verify runner detection doesn't raise and registers all three.
    reg = discover_tasks(tmp_path)
    assert set(reg.tasks) == {"p1.lint", "p2.lint", "p3.lint"}


def test_cli_package_and_each_selection(tmp_path: Path) -> None:
    py_exe = sys.executable
    (tmp_path / "tasknest.toml").write_text(
        "[tasknest]\nconfig_version = 1\n\n"
        '[[discovery.manifests]]\npath = "services/*"\n\n'
        '[marks]\nfast = "Fast"\n',
        encoding="utf-8",
    )
    for pkg, msg in (("alpha", "ALPHA"), ("beta", "BETA")):
        d = tmp_path / "services" / pkg
        d.mkdir(parents=True)
        (d / "pyproject.toml").write_text(
            f"[tool.tasknest.tasks]\n"
            f'prep = {{ cmd = [{py_exe!r}, "-c", "print(\'{msg}_PREP\')"] }}\n'
            f'test = {{ cmd = [{py_exe!r}, "-c", "print(\'{msg}_TEST\')"], '
            f'depends = ["prep"], marks = ["fast"] }}\n',
            encoding="utf-8",
        )

    runner = CliRunner(tmp_path)

    ls_res = runner.invoke(["ls", "-p", "alpha"])
    assert ls_res.exit_code == 0
    assert "alpha test (alpha.test)" in ls_res.stdout
    assert "beta.test" not in ls_res.stdout

    plan_res = runner.invoke(["plan", "--each", "test"])
    assert plan_res.exit_code == 0
    assert "alpha.prep" in plan_res.stdout
    assert "alpha.test" in plan_res.stdout
    assert "beta.test" in plan_res.stdout

    run_each = runner.invoke(["run", "--each", "test"])
    assert run_each.exit_code == 0
    assert "ALPHA_PREP" in run_each.stdout
    assert "ALPHA_TEST" in run_each.stdout
    assert "BETA_TEST" in run_each.stdout

    run_pkg_mark = runner.invoke(["run", "-p", "beta", "--mark", "fast"])
    assert run_pkg_mark.exit_code == 0
    assert "BETA_TEST" in run_pkg_mark.stdout
    assert "ALPHA_TEST" not in run_pkg_mark.stdout

    bad_combo = runner.invoke(["run", "--mark", "fast", "--each", "test"])
    assert bad_combo.exit_code == 2

    wrong_pkg = runner.invoke(["run", "-p", "alpha", "beta", "test"])
    assert wrong_pkg.exit_code == 2


def test_manifest_validation_errors(tmp_path: Path) -> None:
    (tmp_path / "tasknest.toml").write_text(
        '[tasknest]\nconfig_version = 1\n\n[[discovery.manifests]]\npath = "missing_dir"\n',
        encoding="utf-8",
    )
    with pytest.raises(DiscoveryError, match="does not exist"):
        discover_tasks(tmp_path)

    (tmp_path / "tasknest.toml").write_text(
        '[tasknest]\nconfig_version = 1\n\n[[discovery.manifests]]\npath = "svc"\n',
        encoding="utf-8",
    )
    svc = tmp_path / "svc"
    svc.mkdir()
    (svc / "pyproject.toml").write_text(
        '[tool.tasknest.tasks]\nbad = "not_a_list"\n', encoding="utf-8"
    )
    with pytest.raises(ConfigError, match="must be array or table"):
        discover_tasks(tmp_path)

    (svc / "pyproject.toml").write_text(
        "[tool.tasknest.tasks]\nempty = { cmd = [] }\n", encoding="utf-8"
    )
    with pytest.raises(ConfigError, match="non-empty cmd"):
        discover_tasks(tmp_path)

    (svc / "pyproject.toml").write_text(
        '[tool.tasknest.tasks]\nok = ["echo", "hi"]\n', encoding="utf-8"
    )
    reg = discover_tasks(tmp_path)
    (tmp_path / "tasknest.toml").write_text(
        "[tasknest]\nconfig_version = 1\n\n"
        '[[discovery.manifests]]\npath = "svc"\n\n'
        '[checks]\nstrict = true\nunknown_marks = "error"\n',
        encoding="utf-8",
    )
    (svc / "pyproject.toml").write_text(
        '[tool.tasknest.tasks]\nok = { cmd = ["echo", "hi"], marks = ["ghost"] }\n',
        encoding="utf-8",
    )
    reg = discover_tasks(tmp_path)
    with pytest.raises(ValidationError, match="ghost"):
        validate_registry(reg)
