"""Package version resolution from pyproject.toml or installed metadata."""

from __future__ import annotations

from importlib import metadata
from pathlib import Path

try:
    import tomllib  # type: ignore[import-not-found]  # stdlib in >=3.11; tomli on 3.10
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 fallback
    import tomli as tomllib

_PACKAGE_NAME = "tasknest"


def _read_manifest_version() -> str | None:
    manifest_path = Path(__file__).resolve().parents[2] / "pyproject.toml"
    if not manifest_path.is_file():
        return None
    data = tomllib.loads(manifest_path.read_text(encoding="utf-8"))
    project = data.get("project")
    if not isinstance(project, dict) or project.get("name") != _PACKAGE_NAME:
        return None
    raw_version = project.get("version")
    return raw_version if isinstance(raw_version, str) and raw_version else None


def _resolve_version() -> str:
    manifest_version = _read_manifest_version()
    if manifest_version is not None:
        return manifest_version
    return metadata.version(_PACKAGE_NAME)


VERSION: str = _resolve_version()
__version__: str = VERSION
