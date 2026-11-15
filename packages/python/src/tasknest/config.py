"""Configuration loading for tasknest.toml."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    import tomllib  # type: ignore[import-not-found]  # stdlib in >=3.11; tomli on 3.10
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 fallback
    import tomli as tomllib

from tasknest.errors import ConfigError

DEFAULT_CONFIG_NAME = "tasknest.toml"
_DOT = "."


@dataclass(frozen=True)
class DiscoveryRoot:
    """One configured discovery root entry."""

    path: Path
    namespace: str = ""
    project_root: Path = Path(_DOT)


@dataclass(frozen=True)
class TasknestConfig:
    """Parsed Tasknest workspace configuration."""

    repo_root: Path
    roots: tuple[DiscoveryRoot, ...]
    marks: dict[str, str]
    jobs: int = 1


def _require_str(entry: dict[str, Any], field: str, default: str | None = None) -> str:
    raw = entry.get(field, default)
    if not isinstance(raw, str):
        raise ConfigError(f"[[discovery.roots]] field '{field}' must be a string.")
    return raw


def _parse_root(entry: object) -> DiscoveryRoot:
    if not isinstance(entry, dict) or "path" not in entry:
        raise ConfigError("Each [[discovery.roots]] entry must be a table with a 'path'.")
    raw_path = _require_str(entry, "path")
    raw_ns = _require_str(entry, "namespace", "")
    raw_proj = _require_str(entry, "project_root", _DOT)
    return DiscoveryRoot(
        path=Path(raw_path),
        namespace=raw_ns.strip(_DOT),
        project_root=Path(raw_proj),
    )


def _parse_marks(raw_marks: object) -> dict[str, str]:
    if raw_marks is None:
        return {}
    if not isinstance(raw_marks, dict):
        raise ConfigError("[marks] must be a table.")
    for key, desc in raw_marks.items():
        if type(key) is not str or type(desc) is not str:
            raise ConfigError("[marks] values must map mark names to string descriptions.")
    return dict(raw_marks)


def _extract_roots(raw: dict[str, Any]) -> tuple[DiscoveryRoot, ...]:
    discovery = raw.get("discovery", {})
    if not isinstance(discovery, dict):
        raise ConfigError("[discovery] must be a table.")
    raw_roots = discovery.get("roots")
    if raw_roots is None:
        return (DiscoveryRoot(path=Path("tools")),)
    if not isinstance(raw_roots, list):
        raise ConfigError("[[discovery.roots]] must be an array of tables.")
    return tuple(_parse_root(item) for item in raw_roots)


def _resolve_config_target(resolved_root: Path, config_path: Path | None) -> Path | None:
    if config_path is None:
        candidate = resolved_root / DEFAULT_CONFIG_NAME
        return candidate if candidate.exists() else None
    target = config_path if config_path.is_absolute() else (resolved_root / config_path)
    if not target.exists():
        raise ConfigError(f"Configuration file not found: {target}")
    return target


def _extract_jobs(raw: dict[str, Any]) -> int:
    execution = raw.get("execution", {})
    jobs = execution.get("jobs", 1) if isinstance(execution, dict) else 1
    if type(jobs) is not int or jobs < 1:
        raise ConfigError("[execution].jobs must be a positive integer.")
    return jobs


def load_config(repo_root: Path, config_path: Path | None = None) -> TasknestConfig:
    """Load tasknest.toml from repo_root or an explicit path."""
    resolved_root = repo_root.resolve()
    target = _resolve_config_target(resolved_root, config_path)
    if target is None:
        return TasknestConfig(
            repo_root=resolved_root, roots=(DiscoveryRoot(path=Path("tools")),), marks={}
        )
    try:
        raw = tomllib.loads(target.read_text(encoding="utf-8"))
    except (tomllib.TOMLDecodeError, ValueError) as exc:
        raise ConfigError(f"Invalid TOML in {target}: {exc}") from exc
    return TasknestConfig(
        repo_root=resolved_root,
        roots=_extract_roots(raw),
        marks=_parse_marks(raw.get("marks")),
        jobs=_extract_jobs(raw),
    )
