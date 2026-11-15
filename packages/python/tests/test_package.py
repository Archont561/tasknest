"""Basic package scaffold and module-to-test parity checks."""

from __future__ import annotations

from pathlib import Path

from tasknest import __version__


def test_version_is_defined() -> None:
    assert __version__.endswith(".dev0")


def test_every_source_module_has_corresponding_test() -> None:
    pkg_root = Path(__file__).resolve().parent.parent
    src_dir = pkg_root / "src/tasknest"
    tests_dir = pkg_root / "tests"
    missing = [
        mod.name
        for mod in sorted(src_dir.glob("*.py"))
        if not mod.name.startswith("_") and not (tests_dir / f"test_{mod.stem}.py").exists()
    ]
    assert missing == [], f"Missing test files for modules: {missing}"
