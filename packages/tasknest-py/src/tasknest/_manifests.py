"""Tier-1 manifest discovery for package.json scripts and pyproject.toml tasks."""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

try:
    import tomllib  # type: ignore[import-not-found]
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 fallback
    import tomli as tomllib

from tasknest.config import ManifestRoot, TasknestConfig
from tasknest.errors import ConfigError, DiscoveryError
from tasknest.task import TaskDefinition

if TYPE_CHECKING:
    from pathlib import Path

    from tasknest.context import ToolContext

_UTF8 = "utf-8"
_DOT = "."
_DEFAULT_JS_RUNNER = "bun"
_FALLBACK_JS_RUNNER = "npm"
_IGNORED_DIRS = frozenset({"node_modules", ".git", ".pixi", "dist", "out", ".next"})
_GLOB_CHARS = frozenset({"*", "?", "["})
_LOCKFILE_RUNNERS: tuple[tuple[str, str], ...] = (
    ("bun.lock", _DEFAULT_JS_RUNNER),
    ("bun.lockb", _DEFAULT_JS_RUNNER),
    ("pnpm-lock.yaml", "pnpm"),
    ("yarn.lock", "yarn"),
    ("package-lock.json", _FALLBACK_JS_RUNNER),
)


@dataclass(frozen=True)
class _MetaSpec:
    description: str
    depends: tuple[str, ...]
    marks: tuple[str, ...]
    requires: tuple[str, ...]
    inputs: tuple[str, ...]
    outputs: tuple[str, ...]
    cache: bool
    persistent: bool
    env: tuple[str, ...]
    resources: tuple[str, ...]


@dataclass(frozen=True)
class _PackageTarget:
    pkg_dir: Path
    repo_root: Path
    entry: ManifestRoot

    @property
    def rel_dir(self) -> str:
        if self.pkg_dir == self.repo_root:
            return _DOT
        return str(self.pkg_dir.relative_to(self.repo_root))


@dataclass(frozen=True)
class _CmdTaskSpec:
    argv: tuple[str, ...]
    meta: _MetaSpec
    canonical: str
    cli_path: tuple[str, ...]
    package_name: str
    source: Path
    pkg_dir: Path


def _is_glob(pattern: str) -> bool:
    return any(ch in pattern for ch in _GLOB_CHARS)


def _extract_workspace_patterns(raw_ws: object) -> list[str]:
    if isinstance(raw_ws, list):
        return [p for p in raw_ws if isinstance(p, str) and p]
    if isinstance(raw_ws, dict):
        pkgs = raw_ws.get("packages")
        if isinstance(pkgs, list):
            return [p for p in pkgs if isinstance(p, str) and p]
    return []


def _expand_workspace_entries(config: TasknestConfig) -> tuple[ManifestRoot, ...]:
    entries = list(config.manifests)
    if not config.workspaces:
        return tuple(entries)
    pkg_json = config.repo_root / "package.json"
    if not pkg_json.is_file():
        return tuple(entries)
    data = _read_json_table(pkg_json)
    seen = {entry.path for entry in entries}
    for pat in _extract_workspace_patterns(data.get("workspaces")):
        if pat not in seen:
            entries.append(ManifestRoot(path=pat))
            seen.add(pat)
    return tuple(entries)


def _expand_manifest_dirs(repo_root: Path, entry: ManifestRoot) -> list[Path]:
    if _is_glob(entry.path):
        return [
            p
            for p in sorted(repo_root.glob(entry.path))
            if p.is_dir() and p.name not in _IGNORED_DIRS
        ]
    target = (repo_root / entry.path).resolve()
    if not target.is_dir():
        raise DiscoveryError(f"Configured manifest path does not exist: {target}")
    return [target]


def _read_json_table(path: Path) -> dict[str, Any]:
    try:
        loaded = json.loads(path.read_text(encoding=_UTF8))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError(f"Invalid JSON in {path}: {exc}") from exc
    if not isinstance(loaded, dict):
        raise ConfigError(f"Manifest {path} root must be a JSON object.")
    return loaded


def _read_toml_table(path: Path) -> dict[str, Any]:
    try:
        loaded = tomllib.loads(path.read_text(encoding=_UTF8))
    except (OSError, tomllib.TOMLDecodeError, ValueError) as exc:
        raise ConfigError(f"Invalid TOML in {path}: {exc}") from exc
    if not isinstance(loaded, dict):
        raise ConfigError(f"Manifest {path} root must be a TOML table.")
    return loaded


def _detect_js_runner(pkg_dir: Path, repo_root: Path, configured: str) -> str:
    if configured != "auto":
        return configured
    for base in (pkg_dir, repo_root):
        for lock_name, runner in _LOCKFILE_RUNNERS:
            if (base / lock_name).is_file():
                return runner
    return _DEFAULT_JS_RUNNER if shutil.which(_DEFAULT_JS_RUNNER) else _FALLBACK_JS_RUNNER


def _is_nonempty_str(item: object) -> bool:
    return type(item) is str and bool(item)


def _as_str_tuple(raw: Any, label: str, source: Path) -> tuple[str, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list) or not all(_is_nonempty_str(item) for item in raw):
        raise ConfigError(f"{label} in {source} must be a list of non-empty strings.")
    return tuple(raw)


def _as_bool(raw: Any, default: bool, label: str, source: Path) -> bool:
    if raw is None:
        return default
    if type(raw) is not bool:
        raise ConfigError(f"{label} in {source} must be a boolean.")
    return raw


def _parse_meta(
    raw_meta: dict[str, Any],
    default_desc: str,
    default_persistent: bool,
    source: Path,
) -> _MetaSpec:
    raw_desc = raw_meta.get("description")
    if raw_desc is not None and type(raw_desc) is not str:
        raise ConfigError(f"description in {source} must be a string.")
    desc = raw_desc.strip() if isinstance(raw_desc, str) and raw_desc.strip() else default_desc
    return _MetaSpec(
        description=desc,
        depends=_as_str_tuple(raw_meta.get("depends"), "depends", source),
        marks=_as_str_tuple(raw_meta.get("marks"), "marks", source),
        requires=_as_str_tuple(raw_meta.get("requires"), "requires", source),
        inputs=_as_str_tuple(raw_meta.get("inputs"), "inputs", source),
        outputs=_as_str_tuple(raw_meta.get("outputs"), "outputs", source),
        cache=_as_bool(raw_meta.get("cache"), False, "cache", source),
        persistent=_as_bool(raw_meta.get("persistent"), default_persistent, "persistent", source),
        env=_as_str_tuple(raw_meta.get("env"), "env", source),
        resources=_as_str_tuple(raw_meta.get("resources"), "resources", source),
    )


def _make_cmd_task(spec: _CmdTaskSpec) -> TaskDefinition:
    argv = spec.argv

    def _runner(ctx: ToolContext) -> None:
        ctx.run(argv)

    _runner.__name__ = spec.canonical.replace(_DOT, "_")
    meta = spec.meta
    return TaskDefinition(
        callable_fn=_runner,
        name=spec.canonical,
        depends=meta.depends,
        marks=meta.marks,
        requires=meta.requires,
        description=meta.description,
        takes_context=True,
        options=(),
        inputs=meta.inputs,
        outputs=meta.outputs,
        cache=meta.cache,
        persistent=meta.persistent,
        env=meta.env,
        resources=meta.resources,
        package_name=spec.package_name,
        is_manifest=True,
        source_path=spec.source,
        root_dir=spec.pkg_dir,
        project_root=spec.pkg_dir,
        cli_path=spec.cli_path,
    )


def _resolve_package_id(target: _PackageTarget, custom_ns: Any) -> tuple[tuple[str, ...], str]:
    ns_parts = tuple(p for p in target.entry.namespace.split(_DOT) if p)
    if isinstance(custom_ns, str) and custom_ns.strip():
        pkg_seg = custom_ns.strip().strip(_DOT)
    elif target.pkg_dir == target.repo_root:
        pkg_seg = "root"
    else:
        pkg_seg = target.pkg_dir.name
    parts = ns_parts + tuple(p for p in pkg_seg.split(_DOT) if p)
    return parts, _DOT.join(parts)


def _require_json_obj(val: object, label: str, source: Path) -> dict[str, Any]:
    if val is None:
        return {}
    if not isinstance(val, dict):
        raise ConfigError(f"'{label}' in {source} must be an object.")
    return val


def _pkg_json_task(
    *,
    name: str,
    raw_meta: object,
    runner: str,
    rel_dir: str,
    persistent_scripts: tuple[str, ...],
    pkg_parts: tuple[str, ...],
    pkg_id: str,
    manifest_path: Path,
    pkg_dir: Path,
) -> TaskDefinition:
    if not isinstance(raw_meta, dict):
        raise ConfigError(f"tasknest.tasks.{name} in {manifest_path} must be an object.")
    custom_cmd = raw_meta.get("cmd")
    if custom_cmd is not None:
        argv = _as_str_tuple(custom_cmd, f"tasknest.tasks.{name}.cmd", manifest_path)
        if not argv:
            raise ConfigError(f"tasknest.tasks.{name}.cmd in {manifest_path} cannot be empty.")
    else:
        argv = (runner, "run", name)
    meta = _parse_meta(
        raw_meta,
        default_desc=f"Run package.json script '{name}' in {rel_dir}.",
        default_persistent=name in persistent_scripts,
        source=manifest_path,
    )
    cli_path = pkg_parts + (name,)
    return _make_cmd_task(
        _CmdTaskSpec(
            argv=argv,
            meta=meta,
            canonical=_DOT.join(cli_path),
            cli_path=cli_path,
            package_name=pkg_id,
            source=manifest_path,
            pkg_dir=pkg_dir,
        )
    )


def _collect_package_json_tasks(
    target: _PackageTarget, pkg_tasks: dict[str, TaskDefinition]
) -> None:
    manifest_path = target.pkg_dir / "package.json"
    if not manifest_path.is_file():
        return
    data = _read_json_table(manifest_path)
    scripts = _require_json_obj(data.get("scripts"), "scripts", manifest_path)
    tn = _require_json_obj(data.get("tasknest"), "tasknest", manifest_path)
    tn_tasks = _require_json_obj(tn.get("tasks"), "tasknest.tasks", manifest_path)
    runner = _detect_js_runner(
        target.pkg_dir, target.repo_root, tn.get("runner") or target.entry.runner
    )
    pkg_parts, pkg_id = _resolve_package_id(target, tn.get("namespace"))
    excluded = set(target.entry.exclude_scripts)
    names = [s for s in scripts if s not in excluded]
    names.extend(s for s in tn_tasks if s not in scripts and s not in excluded)
    for name in names:
        task = _pkg_json_task(
            name=name,
            raw_meta=tn_tasks.get(name, {}),
            runner=runner,
            rel_dir=target.rel_dir,
            persistent_scripts=target.entry.persistent_scripts,
            pkg_parts=pkg_parts,
            pkg_id=pkg_id,
            manifest_path=manifest_path,
            pkg_dir=target.pkg_dir,
        )
        pkg_tasks[task.name] = task


def _parse_pyproject_spec(
    name: str, spec: object, manifest_path: Path
) -> tuple[tuple[str, ...], dict[str, Any]]:
    if isinstance(spec, list):
        argv = _as_str_tuple(spec, f"[tool.tasknest.tasks.{name}]", manifest_path)
        raw_meta: dict[str, Any] = {}
    elif isinstance(spec, dict):
        argv = _as_str_tuple(spec.get("cmd"), f"[tool.tasknest.tasks.{name}].cmd", manifest_path)
        raw_meta = spec
    else:
        raise ConfigError(
            f"[tool.tasknest.tasks.{name}] in {manifest_path} must be array or table."
        )
    if not argv:
        raise ConfigError(
            f"[tool.tasknest.tasks.{name}] in {manifest_path} requires non-empty cmd."
        )
    return argv, raw_meta


def _extract_pyproject_tasknest(
    manifest_path: Path,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    if not manifest_path.is_file():
        return None
    data = _read_toml_table(manifest_path)
    tool_tbl = data.get("tool")
    if not isinstance(tool_tbl, dict) or "tasknest" not in tool_tbl:
        return None
    tn = tool_tbl["tasknest"]
    if not isinstance(tn, dict):
        raise ConfigError(f"[tool.tasknest] in {manifest_path} must be a table.")
    raw_tasks = tn.get("tasks", {})
    if not isinstance(raw_tasks, dict):
        raise ConfigError(f"[tool.tasknest.tasks] in {manifest_path} must be a table.")
    return tn, raw_tasks


def _collect_pyproject_tasks(target: _PackageTarget, pkg_tasks: dict[str, TaskDefinition]) -> None:
    manifest_path = target.pkg_dir / "pyproject.toml"
    extracted = _extract_pyproject_tasknest(manifest_path)
    if extracted is None:
        return
    tn, raw_tasks = extracted
    pkg_parts, pkg_id = _resolve_package_id(target, tn.get("namespace"))
    excluded = set(target.entry.exclude_scripts)
    for name, spec in raw_tasks.items():
        if name in excluded:
            continue
        argv, raw_meta = _parse_pyproject_spec(name, spec, manifest_path)
        meta = _parse_meta(
            raw_meta,
            default_desc=f"Run pyproject.toml task '{name}' in {target.rel_dir}.",
            default_persistent=name in target.entry.persistent_scripts,
            source=manifest_path,
        )
        cli_path = pkg_parts + (name,)
        canonical = _DOT.join(cli_path)
        if canonical in pkg_tasks:
            raise DiscoveryError(
                f"Duplicate manifest task name {canonical!r} found in {manifest_path}."
            )
        pkg_tasks[canonical] = _make_cmd_task(
            _CmdTaskSpec(
                argv=argv,
                meta=meta,
                canonical=canonical,
                cli_path=cli_path,
                package_name=pkg_id,
                source=manifest_path,
                pkg_dir=target.pkg_dir,
            )
        )


def _resolve_relative_deps(pkg_tasks: dict[str, TaskDefinition]) -> None:
    for _canonical, task in pkg_tasks.items():
        if not task.depends or task.package_name is None:
            continue
        updated: list[str | TaskDefinition] = []
        for dep in task.depends:
            if isinstance(dep, str) and _DOT not in dep:
                candidate = f"{task.package_name}.{dep}"
                updated.append(candidate if candidate in pkg_tasks else dep)
            else:
                updated.append(dep)
        task.depends = tuple(updated)


def discover_manifest_tasks(config: TasknestConfig, tasks: dict[str, TaskDefinition]) -> None:
    """Discover manifest-declared tasks from package.json and pyproject.toml."""
    for entry in _expand_workspace_entries(config):
        for pkg_dir in _expand_manifest_dirs(config.repo_root, entry):
            target = _PackageTarget(pkg_dir=pkg_dir, repo_root=config.repo_root, entry=entry)
            pkg_tasks: dict[str, TaskDefinition] = {}
            _collect_package_json_tasks(target, pkg_tasks)
            _collect_pyproject_tasks(target, pkg_tasks)
            _resolve_relative_deps(pkg_tasks)
            for canonical, task in pkg_tasks.items():
                if canonical in tasks:
                    raise DiscoveryError(
                        f"Duplicate manifest task name {canonical!r} found in {task.source_path}."
                    )
                tasks[canonical] = task
