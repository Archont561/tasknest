"""Basic package scaffold and module-to-test parity checks."""

from __future__ import annotations

from pathlib import Path

try:
    import tomllib  # type: ignore[import-not-found]  # stdlib in >=3.11; tomli on 3.10
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 fallback
    import tomli as tomllib

from tasknest import VERSION, __version__


def test_version_matches_manifest() -> None:
    pyproject_path = Path(__file__).resolve().parent.parent / "pyproject.toml"
    manifest = tomllib.loads(pyproject_path.read_text(encoding="utf-8"))
    expected = manifest["project"]["version"]
    assert expected == VERSION
    assert __version__ == VERSION
    assert VERSION.endswith(".dev0")
    assert manifest["project"]["scripts"]["tasknest"] == "tasknest.cli:main"


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
