"""Configuration loading for tasknest.toml."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

try:
    import tomllib  # type: ignore[import-not-found]  # stdlib in >=3.11; tomli on 3.10
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 fallback
    import tomli as tomllib

from tasknest.errors import ConfigError

DEFAULT_CONFIG_NAME = "tasknest.toml"
_DOT = "."
_CHECKS_SECTION = "checks"
_IGNORE_MODE = "ignore"
_VALID_MARK_MODES = frozenset({_IGNORE_MODE, "warn", "error"})
_VALID_RUNNERS = frozenset({"auto", "bun", "npm", "pnpm", "yarn"})
RunnerKind = Literal["auto", "bun", "npm", "pnpm", "yarn"]


@dataclass(frozen=True)
class ChecksConfig:
    """Structural and mark validation settings from [checks]."""

    strict: bool = False
    require_description: bool = False
    require_tests: bool = False
    require_features: bool = False
    unknown_marks: Literal["ignore", "warn", "error"] = "ignore"


@dataclass(frozen=True)
class SkillConfig:
    """Agent skill generation settings from [skill]."""

    output: str = ".agents/skills/project-tools/SKILL.md"
    command: str = "tasknest"
    template: str | None = None


@dataclass(frozen=True)
class DiscoveryRoot:
    """One configured discovery root entry."""

    path: Path
    namespace: str = ""
    project_root: Path = Path(_DOT)


@dataclass(frozen=True)
class ManifestRoot:
    """One configured manifest discovery entry (package.json / pyproject.toml)."""

    path: str
    namespace: str = ""
    runner: RunnerKind = "auto"
    persistent_scripts: tuple[str, ...] = ()
    exclude_scripts: tuple[str, ...] = ()


@dataclass(frozen=True)
class TasknestConfig:
    """Parsed Tasknest workspace configuration."""

    repo_root: Path
    roots: tuple[DiscoveryRoot, ...]
    marks: dict[str, str]
    manifests: tuple[ManifestRoot, ...] = ()
    workspaces: bool = False
    jobs: int = 1
    checks: ChecksConfig = field(default_factory=ChecksConfig)
    skill: SkillConfig = field(default_factory=SkillConfig)


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
        if discovery.get("manifests") is not None or discovery.get("workspaces"):
            return ()
        return (DiscoveryRoot(path=Path("tools")),)
    if not isinstance(raw_roots, list):
        raise ConfigError("[[discovery.roots]] must be an array of tables.")
    return tuple(_parse_root(item) for item in raw_roots)


def _require_str_seq(entry: dict[str, Any], key: str) -> tuple[str, ...]:
    raw = entry.get(key)
    if raw is None:
        return ()
    if not isinstance(raw, list) or any(type(item) is not str or not item for item in raw):
        raise ConfigError(f"[[discovery.manifests]] field '{key}' must be a list of strings.")
    return tuple(raw)


def _parse_manifest(entry: object) -> ManifestRoot:
    if not isinstance(entry, dict) or "path" not in entry:
        raise ConfigError("Each [[discovery.manifests]] entry must be a table with a 'path'.")
    raw_path = entry.get("path")
    raw_ns = entry.get("namespace", "")
    runner = entry.get("runner", "auto")
    if type(raw_path) is not str or not raw_path:
        raise ConfigError("[[discovery.manifests]] field 'path' must be a non-empty string.")
    if type(raw_ns) is not str:
        raise ConfigError("[[discovery.manifests]] field 'namespace' must be a string.")
    if runner not in _VALID_RUNNERS:
        raise ConfigError(f"[[discovery.manifests]] invalid runner {runner!r}.")
    return ManifestRoot(
        path=raw_path,
        namespace=raw_ns.strip(_DOT),
        runner=runner,
        persistent_scripts=_require_str_seq(entry, "persistent_scripts"),
        exclude_scripts=_require_str_seq(entry, "exclude_scripts"),
    )


def _extract_manifests(raw: dict[str, Any]) -> tuple[tuple[ManifestRoot, ...], bool]:
    discovery = raw.get("discovery", {})
    if not isinstance(discovery, dict):
        raise ConfigError("[discovery] must be a table.")
    workspaces = discovery.get("workspaces", False)
    if type(workspaces) is not bool:
        raise ConfigError("[discovery].workspaces must be a boolean.")
    raw_manifests = discovery.get("manifests")
    if raw_manifests is None:
        return (), workspaces
    if not isinstance(raw_manifests, list):
        raise ConfigError("[[discovery.manifests]] must be an array of tables.")
    return tuple(_parse_manifest(item) for item in raw_manifests), workspaces


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


def _require_bool(table: dict[str, Any], key: str, default: bool, section: str) -> bool:
    val = table.get(key, default)
    if type(val) is not bool:
        raise ConfigError(f"[{section}].{key} must be a boolean.")
    return val


def _parse_checks(raw_checks: object) -> ChecksConfig:
    if raw_checks is None:
        return ChecksConfig()
    if not isinstance(raw_checks, dict):
        raise ConfigError("[checks] must be a table.")
    mode = raw_checks.get("unknown_marks", _IGNORE_MODE)
    if mode not in _VALID_MARK_MODES:
        raise ConfigError("[checks].unknown_marks must be 'ignore', 'warn', or 'error'.")
    return ChecksConfig(
        strict=_require_bool(raw_checks, "strict", False, _CHECKS_SECTION),
        require_description=_require_bool(
            raw_checks, "require_description", False, _CHECKS_SECTION
        ),
        require_tests=_require_bool(raw_checks, "require_tests", False, _CHECKS_SECTION),
        require_features=_require_bool(raw_checks, "require_features", False, _CHECKS_SECTION),
        unknown_marks=mode,
    )


def _parse_skill(raw_skill: object) -> SkillConfig:
    if raw_skill is None:
        return SkillConfig()
    if not isinstance(raw_skill, dict):
        raise ConfigError("[skill] must be a table.")
    output = raw_skill.get("output", SkillConfig.output)
    command = raw_skill.get("command", SkillConfig.command)
    template = raw_skill.get("template")
    if type(output) is not str or not output:
        raise ConfigError("[skill].output must be a non-empty string.")
    if type(command) is not str or not command:
        raise ConfigError("[skill].command must be a non-empty string.")
    if template is not None and (type(template) is not str or not template):
        raise ConfigError("[skill].template must be a non-empty string.")
    return SkillConfig(output=output, command=command, template=template)


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
    manifests, workspaces = _extract_manifests(raw)
    return TasknestConfig(
        repo_root=resolved_root,
        roots=_extract_roots(raw),
        marks=_parse_marks(raw.get("marks")),
        manifests=manifests,
        workspaces=workspaces,
        jobs=_extract_jobs(raw),
        checks=_parse_checks(raw.get("checks")),
        skill=_parse_skill(raw.get("skill")),
    )
