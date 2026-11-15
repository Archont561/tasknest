"""Verify built Python package wheel and sdist compatibility in isolation."""

from __future__ import annotations

import os
import site
import subprocess
import sys
import tempfile
import zipfile
from email.parser import Parser
from pathlib import Path

_PKG_NAME = "tasknest"
_NO_INDEX = "--no-index"
_NO_DEPS = "--no-deps"
_BIN = "bin"
_SMOKE_CODE = (
    "import tasknest; "
    "assert tasknest.VERSION == tasknest.__version__ "
    "and bool(tasknest.VERSION), tasknest.VERSION"
)


def _run(argv: tuple[str, ...], cwd: Path, env: dict[str, str] | None = None) -> bool:
    print("+ " + " ".join(argv), flush=True)
    return subprocess.run(argv, cwd=cwd, env=env, check=False).returncode == 0


def _verify_wheel_metadata(whl: Path) -> bool:
    with zipfile.ZipFile(whl) as archive:
        names = archive.namelist()
        meta_path = next((name for name in names if name.endswith("/METADATA")), None)
        if f"{_PKG_NAME}/__init__.py" not in names or meta_path is None:
            print(f"Incomplete wheel archive {whl.name}", file=sys.stderr)
            return False
        meta = Parser().parsestr(archive.read(meta_path).decode("utf-8"))
    requires = meta.get_all("Requires-Dist") or []
    extras = meta.get_all("Provides-Extra") or []
    has_identity = meta.get("Name") == _PKG_NAME and meta.get("Requires-Python") == ">=3.10"
    has_expected_deps = "skill" in extras and all(
        "extra ==" in req or "python_version" in req for req in requires
    )
    valid = has_identity and has_expected_deps
    if not valid:
        print(f"Unexpected metadata in {whl.name}: {meta.items()}", file=sys.stderr)
    return valid


def _verify_venv_install(
    artifact: Path,
    venv_dir: Path,
    tmp_path: Path,
    *,
    build_isolation: bool,
) -> bool:
    if not _run((sys.executable, "-m", "virtualenv", str(venv_dir)), tmp_path):
        return False
    install_cmd = [str(venv_dir / _BIN / "pip"), "install", _NO_INDEX, _NO_DEPS]
    env = None
    if not build_isolation:
        install_cmd.append("--no-build-isolation")
        env = os.environ.copy()
        env["PYTHONPATH"] = os.pathsep.join(site.getsitepackages())
    install_cmd.append(str(artifact))
    return (
        _run(tuple(install_cmd), tmp_path, env=env)
        and _run((str(venv_dir / _BIN / "python"), "-c", _SMOKE_CODE), tmp_path)
        and _run((str(venv_dir / _BIN / _PKG_NAME), "--version"), tmp_path)
    )


def verify_py_compat(root: Path) -> bool:
    """Build packages/tasknest-py wheel and sdist and verify clean isolated installs."""
    pkg_dir = root / "packages/tasknest-py"
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        if not _run((sys.executable, "-m", "hatchling", "build", "-d", tmp), pkg_dir):
            return False
        whl = next(tmp_path.glob(f"{_PKG_NAME}-*.whl"))
        sdist = next(tmp_path.glob(f"{_PKG_NAME}-*.tar.gz"))
        return (
            _verify_wheel_metadata(whl)
            and _verify_venv_install(whl, tmp_path / "venv-wheel", tmp_path, build_isolation=True)
            and _verify_venv_install(
                sdist, tmp_path / "venv-sdist", tmp_path, build_isolation=False
            )
        )


if __name__ == "__main__":
    raise SystemExit(0 if verify_py_compat(Path(__file__).resolve().parent.parent) else 1)
