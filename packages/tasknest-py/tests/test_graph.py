"""BDD and Hypothesis property tests for tasknest.graph."""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import pytest
from hypothesis import given
from hypothesis import strategies as st
from pytest_bdd import given as bdd_given
from pytest_bdd import parsers, scenarios, then, when
from tasknest.discovery import TaskRegistry, discover_tasks
from tasknest.errors import GraphError
from tasknest.graph import ExecutionReport, plan_execution, run_plan, validate_graph

scenarios(str(Path(__file__).resolve().parent.parent / "features/dependencies.feature"))


@pytest.fixture
def graph_state(tmp_path: Path) -> dict[str, object]:
    tools = tmp_path / "tools"
    tools.mkdir()
    (tools / "_events.py").write_text("LOG: list[str] = []\n", encoding="utf-8")
    return {
        "workspace": tmp_path,
        "tools": tools,
        "registry": None,
        "error": None,
        "report": None,
        "modules": [],
    }


def _write_task(
    state: dict[str, object],
    name: str,
    depends_expr: str = "()",
    body: str | None = None,
) -> None:
    tools = state["tools"]
    assert isinstance(tools, Path)
    fn_body = body or f"    _events.LOG.append({name!r})\n"
    (tools / f"{name}.py").write_text(
        "import _events\n"
        "from tasknest import ToolError, tool\n"
        f"@tool(depends={depends_expr})\n"
        f"def {name}() -> None:\n"
        f"{fn_body}",
        encoding="utf-8",
    )


@bdd_given(parsers.re(r'^task "(?P<name>[^"]+)" depends on canonical name "(?P<dep>[^"]+)"$'))
def given_dep_canonical(graph_state: dict[str, object], name: str, dep: str) -> None:
    _write_task(graph_state, name, depends_expr=f"({dep!r},)")


@bdd_given(
    parsers.re(
        r'^task "(?P<name>[^"]+)" depends on "(?P<dep_a>[^"]+)" '
        r'and task "(?P<other>[^"]+)" depends on "(?P<dep_b>[^"]+)"$'
    )
)
def given_two_deps(
    graph_state: dict[str, object], name: str, dep_a: str, other: str, dep_b: str
) -> None:
    _write_task(graph_state, name, depends_expr=f"({dep_a!r},)")
    _write_task(graph_state, other, depends_expr=f"({dep_b!r},)")


@bdd_given(parsers.re(r'^task "(?P<name>[^"]+)" has no dependencies$'))
def given_no_deps(graph_state: dict[str, object], name: str) -> None:
    _write_task(graph_state, name)


@bdd_given(parsers.re(r'^task "(?P<name>[^"]+)" depends on task reference "(?P<dep>[^"]+)"$'))
def given_dep_ref(graph_state: dict[str, object], name: str, dep: str) -> None:
    tools = graph_state["tools"]
    assert isinstance(tools, Path)
    (tools / f"{name}.py").write_text(
        f"import _events\nimport {dep} as dep_mod\nfrom tasknest import tool\n"
        f"@tool(depends=[dep_mod.{dep}])\n"
        f"def {name}() -> None:\n"
        f"    _events.LOG.append({name!r})\n",
        encoding="utf-8",
    )


@bdd_given(
    parsers.re(r'^task "(?P<name>[^"]+)" depends on "(?P<dep_a>[^"]+)" and "(?P<dep_b>[^"]+)"$')
)
def given_dep_pair(graph_state: dict[str, object], name: str, dep_a: str, dep_b: str) -> None:
    _write_task(graph_state, name, depends_expr=f"({dep_a!r}, {dep_b!r})")


@bdd_given(parsers.re(r'^task "(?P<name>[^"]+)" fails with exit code (?P<code>\d+)$'))
def given_failing_task(graph_state: dict[str, object], name: str, code: str) -> None:
    _write_task(graph_state, name, body=f"    raise ToolError('boom', exit_code={int(code)})\n")


@bdd_given(parsers.re(r'^task "(?P<name>[^"]+)" depends on "(?P<dep>[^"]+)"$'))
def given_single_dep(graph_state: dict[str, object], name: str, dep: str) -> None:
    _write_task(graph_state, name, depends_expr=f"({dep!r},)")


@when("the dependency graph is validated")
def when_validate_graph(graph_state: dict[str, object]) -> None:
    workspace = graph_state["workspace"]
    tools = graph_state["tools"]
    assert isinstance(workspace, Path)
    assert isinstance(tools, Path)
    sys.path.insert(0, str(tools))
    try:
        registry = discover_tasks(workspace)
        validate_graph(registry)
    except GraphError as exc:
        graph_state["error"] = exc
    finally:
        sys.path.remove(str(tools))
        sys.modules.pop("_events", None)


@when(parsers.parse('task "{target}" runs sequentially'))
def when_run_sequential(graph_state: dict[str, object], target: str) -> None:
    workspace = graph_state["workspace"]
    tools = graph_state["tools"]
    assert isinstance(workspace, Path)
    assert isinstance(tools, Path)
    sys.path.insert(0, str(tools))
    try:
        registry = discover_tasks(workspace)
        report = run_plan(registry, target, {})
        import _events  # type: ignore[import-not-found]

        graph_state["log"] = list(_events.LOG)
        graph_state["report"] = report
    finally:
        sys.path.remove(str(tools))
        sys.modules.pop("_events", None)
        for mod_name in list(sys.modules):
            if mod_name in registry.tasks:
                sys.modules.pop(mod_name, None)


@then(parsers.parse('graph validation fails mentioning unknown dependency "{dep}"'))
def then_unknown_dep_error(graph_state: dict[str, object], dep: str) -> None:
    err = graph_state["error"]
    assert isinstance(err, GraphError)
    assert f"Unknown dependency '{dep}'" in str(err)


@then(parsers.parse('graph validation fails showing cycle "{cycle}"'))
def then_cycle_error(graph_state: dict[str, object], cycle: str) -> None:
    err = graph_state["error"]
    assert isinstance(err, GraphError)
    assert cycle in str(err)


@then(parsers.parse('all tasks succeed in order "{expected_csv}"'))
def then_succeed_order(graph_state: dict[str, object], expected_csv: str) -> None:
    report = graph_state["report"]
    assert isinstance(report, ExecutionReport)
    expected = tuple(item.strip() for item in expected_csv.split(","))
    assert report.exit_code == 0
    assert report.succeeded == expected


@then(parsers.parse('task "{name}" executed exactly {count:d} time'))
def then_exec_count(graph_state: dict[str, object], name: str, count: int) -> None:
    log = graph_state["log"]
    assert isinstance(log, list)
    assert log.count(name) == count


@then(parsers.parse("execution returns exit code {code:d}"))
def then_exit_code(graph_state: dict[str, object], code: int) -> None:
    report = graph_state["report"]
    assert isinstance(report, ExecutionReport)
    assert report.exit_code == code


@then(parsers.parse('failed tasks are "{expected_csv}"'))
def then_failed_tasks(graph_state: dict[str, object], expected_csv: str) -> None:
    report = graph_state["report"]
    assert isinstance(report, ExecutionReport)
    assert report.failed == tuple(item.strip() for item in expected_csv.split(","))


@then(parsers.parse('succeeded tasks are "{expected_csv}"'))
def then_succeeded_tasks(graph_state: dict[str, object], expected_csv: str) -> None:
    report = graph_state["report"]
    assert isinstance(report, ExecutionReport)
    assert report.succeeded == tuple(item.strip() for item in expected_csv.split(","))


@then(parsers.parse('blocked tasks are "{expected_csv}"'))
def then_blocked_tasks(graph_state: dict[str, object], expected_csv: str) -> None:
    report = graph_state["report"]
    assert isinstance(report, ExecutionReport)
    assert report.blocked == tuple(item.strip() for item in expected_csv.split(","))


@given(
    size=st.integers(min_value=2, max_value=7),
    edges=st.lists(
        st.tuples(st.integers(min_value=0, max_value=6), st.integers(min_value=0, max_value=6)),
        max_size=12,
    ),
)
def test_property_dag_topological_and_single_execution(
    size: int, edges: list[tuple[int, int]]
) -> None:
    deps: dict[int, list[int]] = {i: [] for i in range(size)}
    for hi, lo in edges:
        if hi < size and lo < size and hi > lo and lo not in deps[hi]:
            deps[hi].append(lo)

    with tempfile.TemporaryDirectory() as tmp:
        workspace = Path(tmp)
        tools = workspace / "tools"
        tools.mkdir()
        for idx in range(size):
            dep_tuple = tuple(f"t{d}" for d in deps[idx])
            (tools / f"t{idx}.py").write_text(
                f"from tasknest import tool\n"
                f"@tool(depends={dep_tuple!r})\n"
                f"def t{idx}() -> None: pass\n",
                encoding="utf-8",
            )
        registry: TaskRegistry = discover_tasks(workspace)
        target = f"t{size - 1}"
        order = plan_execution(registry, target)
        assert len(order) == len(set(order))
        pos = {name: i for i, name in enumerate(order)}
        for node_name in order:
            idx = int(node_name[1:])
            for dep_idx in deps[idx]:
                assert pos[f"t{dep_idx}"] < pos[node_name]
        report = run_plan(registry, target, {})
        assert report.exit_code == 0
        assert report.succeeded == order
