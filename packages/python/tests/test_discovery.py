"""BDD and unit tests for tasknest.discovery."""

from __future__ import annotations

from pathlib import Path

import pytest
import tomli_w
from pytest_bdd import given, parsers, scenarios, then, when
from tasknest.discovery import TaskRegistry, discover_tasks
from tasknest.errors import DiscoveryError

scenarios(str(Path(__file__).resolve().parent.parent / "features/discovery.feature"))


@pytest.fixture
def disc_state(tmp_path: Path) -> dict[str, object]:
    return {"workspace": tmp_path, "roots": [], "registry": None, "error": None}


def _ensure_toml(state: dict[str, object]) -> None:
    workspace = state["workspace"]
    roots = state["roots"]
    assert isinstance(workspace, Path)
    assert isinstance(roots, list)
    payload = {
        "discovery": {
            "roots": [{"path": root_path, "namespace": ns} for root_path, ns in roots],
        }
    }
    (workspace / "tasknest.toml").write_text(tomli_w.dumps(payload), encoding="utf-8")


@given(parsers.parse('a configured root "{root_path}" with namespace "{ns}"'))
@given(parsers.parse('a configured root "{root_path}" with namespace ""'), target_fixture=None)
def given_single_root(disc_state: dict[str, object], root_path: str, ns: str = "") -> None:
    workspace = disc_state["workspace"]
    assert isinstance(workspace, Path)
    (workspace / root_path).mkdir(parents=True, exist_ok=True)
    roots = disc_state["roots"]
    assert isinstance(roots, list)
    roots.append((root_path, ns))
    disc_state["active_root"] = workspace / root_path
    _ensure_toml(disc_state)


@given(parsers.parse('two configured roots "{root_a}" and "{root_b}" without namespaces'))
def given_two_roots(disc_state: dict[str, object], root_a: str, root_b: str) -> None:
    workspace = disc_state["workspace"]
    assert isinstance(workspace, Path)
    (workspace / root_a).mkdir(parents=True, exist_ok=True)
    (workspace / root_b).mkdir(parents=True, exist_ok=True)
    roots = disc_state["roots"]
    assert isinstance(roots, list)
    roots.extend([(root_a, ""), (root_b, "")])
    _ensure_toml(disc_state)


@given(parsers.parse('a task file "{rel_path}" with docstring "{doc}"'))
def given_task_file(disc_state: dict[str, object], rel_path: str, doc: str) -> None:
    active_root = disc_state["active_root"]
    assert isinstance(active_root, Path)
    target = active_root / rel_path
    target.parent.mkdir(parents=True, exist_ok=True)
    fn_name = target.stem
    target.write_text(
        f"from tasknest import ToolContext, tool\n"
        f"@tool()\n"
        f"def {fn_name}(ctx: ToolContext) -> None:\n"
        f'    """{doc}"""\n',
        encoding="utf-8",
    )


@given(parsers.parse('an ignored helper file "{rel_path}"'))
@given(parsers.parse('an ignored file inside "{rel_path}"'))
def given_ignored_file(disc_state: dict[str, object], rel_path: str) -> None:
    active_root = disc_state["active_root"]
    assert isinstance(active_root, Path)
    target = active_root / rel_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("IGNORED_VALUE = 1\n", encoding="utf-8")


@given(parsers.parse('a task file "{rel_path}" containing no tool definition'))
def given_empty_task_file(disc_state: dict[str, object], rel_path: str) -> None:
    active_root = disc_state["active_root"]
    assert isinstance(active_root, Path)
    target = active_root / rel_path
    target.write_text("VALUE = 1\n", encoding="utf-8")


@given(parsers.parse('a task file "{rel_path}" containing two tool definitions'))
def given_multi_task_file(disc_state: dict[str, object], rel_path: str) -> None:
    active_root = disc_state["active_root"]
    assert isinstance(active_root, Path)
    target = active_root / rel_path
    target.write_text(
        "from tasknest import tool\n"
        "@tool()\ndef one() -> None: pass\n"
        "@tool()\ndef two() -> None: pass\n",
        encoding="utf-8",
    )


@given(parsers.parse('both roots define a task file "{rel_path}"'))
def given_duplicate_files(disc_state: dict[str, object], rel_path: str) -> None:
    workspace = disc_state["workspace"]
    roots = disc_state["roots"]
    assert isinstance(workspace, Path)
    assert isinstance(roots, list)
    for root_path, _ in roots:
        target = workspace / root_path / rel_path
        target.write_text(
            f"from tasknest import tool\n@tool()\ndef {target.stem}() -> None: pass\n",
            encoding="utf-8",
        )


@when("tasks are discovered for the workspace")
def when_discover(disc_state: dict[str, object]) -> None:
    workspace = disc_state["workspace"]
    assert isinstance(workspace, Path)
    try:
        disc_state["registry"] = discover_tasks(workspace)
    except DiscoveryError as exc:
        disc_state["error"] = exc


@then(parsers.parse('task "{canonical}" is registered with CLI path "{cli_path}"'))
def then_task_registered(disc_state: dict[str, object], canonical: str, cli_path: str) -> None:
    registry = disc_state["registry"]
    assert isinstance(registry, TaskRegistry)
    assert canonical in registry.tasks
    assert registry.tasks[canonical].cli_path == tuple(cli_path.split())


@then(parsers.parse('task "{canonical}" has description "{desc}"'))
def then_task_description(disc_state: dict[str, object], canonical: str, desc: str) -> None:
    registry = disc_state["registry"]
    assert isinstance(registry, TaskRegistry)
    assert registry.tasks[canonical].description == desc


@then(parsers.parse('only task "{canonical}" is registered'))
def then_only_task(disc_state: dict[str, object], canonical: str) -> None:
    registry = disc_state["registry"]
    assert isinstance(registry, TaskRegistry)
    assert list(registry.tasks) == [canonical]


@then("discovery fails explaining one task per file is required")
def then_one_task_error(disc_state: dict[str, object]) -> None:
    err = disc_state["error"]
    assert isinstance(err, DiscoveryError)
    assert "exactly one @tool" in str(err)


@then(parsers.parse('discovery fails explaining duplicate task "{canonical}"'))
def then_duplicate_error(disc_state: dict[str, object], canonical: str) -> None:
    err = disc_state["error"]
    assert isinstance(err, DiscoveryError)
    assert "Duplicate task name" in str(err)
    assert canonical in str(err)
