"""Shared Python conformance runner against conformance/scenarios.json."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

import pytest
from tasknest.testing import CliRunner

_SCENARIOS_PATH = Path(__file__).resolve().parents[3] / "conformance/scenarios.json"
_HAS_JINJA2 = importlib.util.find_spec("jinja2") is not None


def _py_type_expr(opt: dict[str, Any]) -> str:
    choices = opt.get("choices")
    if choices:
        return f"Literal[{', '.join(repr(c) for c in choices)}]"
    mapping = {"string": "str", "int": "int", "float": "float", "boolean": "bool", "path": "Path"}
    return mapping[str(opt.get("type", "string"))]


def _render_python_body(task: dict[str, Any]) -> list[str]:
    body: list[str] = []
    if task.get("failMessage"):
        return [f"    raise ToolError({task['failMessage']!r})"]
    if "writeFile" in task:
        wf = task["writeFile"]
        body.append(f"    out_file = ctx.project_root / {wf['path']!r}")
        body.append("    out_file.parent.mkdir(parents=True, exist_ok=True)")
        body.append(f"    out_file.write_text({wf['content']!r}, encoding='utf-8')")
    if "outputValue" in task:
        body.append(f"    ctx.output({task['outputValue']!r})")
    if "readDep" in task:
        dep = str(task["readDep"])
        body.append(f"    dep_val = ctx.deps[{dep!r}]")
        body.append(f'    print(f\'DEP:{dep}:{{dep_val["greeting"]}}:{{dep_val["count"]}}\')')
    for msg in task.get("prints", []):
        rendered = str(msg)
        for opt in task.get("options", []):
            name = str(opt["name"])
            expr = f"(str({name}).lower() if isinstance({name}, bool) else {name})"
            rendered = rendered.replace("{{" + name + "}}", "{" + expr + "}")
        body.append(f"    print(f{rendered!r})")
    if not body:
        body.append("    pass")
    return body


def _render_python_task(task: dict[str, Any]) -> str:
    needs_ctx = any(k in task for k in ("writeFile", "outputValue", "readDep"))
    lines = [
        "from pathlib import Path",
        "from typing import Literal",
        "from tasknest import ToolContext, ToolError, tool",
        "",
        "@tool(",
        f"    name={task['name']!r},",
        f"    depends={task.get('depends', [])!r},",
        f"    marks={task.get('marks', [])!r},",
        f"    requires={task.get('requires', [])!r},",
        f"    inputs={task.get('inputs', [])!r},",
        f"    outputs={task.get('outputs', [])!r},",
        f"    cache={bool(task.get('cache', False))!r},",
        f"    description={task.get('description', '')!r},",
        ")",
    ]
    params: list[str] = ["ctx: ToolContext"] if needs_ctx else []
    for opt in task.get("options", []):
        ann = _py_type_expr(opt)
        default = opt.get("default")
        params.append(f"{opt['name']}: {ann} = {default!r}")
    lines.append(f"def {task['name']}({', '.join(params)}) -> None:")
    lines.extend(_render_python_body(task))
    return "\n".join(lines) + "\n"


def _load_scenarios() -> list[dict[str, Any]]:
    payload = json.loads(_SCENARIOS_PATH.read_text(encoding="utf-8"))
    return list(payload["scenarios"])


def _assert_expected_json(stdout: str, expected: dict[str, Any]) -> None:
    payload = json.loads(stdout)
    if "schema_version" in expected:
        assert payload["schema_version"] == expected["schema_version"]
    if "status" in expected:
        assert payload["status"] == expected["status"]
    by_name = {item["name"]: item for item in payload.get("tasks", [])}
    for task_name, cache_status in expected.get("taskCacheStatus", {}).items():
        assert by_name[task_name]["cache_status"] == cache_status
    for task_name, status in expected.get("taskStatus", {}).items():
        assert by_name[task_name]["status"] == status


@pytest.mark.parametrize("scenario", _load_scenarios(), ids=lambda s: str(s["id"]))
def test_shared_conformance_scenario(scenario: dict[str, Any]) -> None:
    if scenario.get("requiresJinja") and not _HAS_JINJA2:
        pytest.skip("jinja2 extra not installed in core environment")
    files: dict[str, str] = {}
    if "config" in scenario:
        files["tasknest.toml"] = str(scenario["config"])
    for rel, content in scenario.get("extraFiles", {}).items():
        key = f"{rel}.py" if rel.startswith("tools/") and "." not in Path(rel).name else rel
        files[key] = str(content)
    for task in scenario.get("tasks", []):
        files[f"tools/{task['path']}.py"] = _render_python_task(task)

    with CliRunner().isolated_workspace(files) as workspace:
        runner = CliRunner(workspace)
        for inv in scenario["invocations"]:
            if "deleteFile" in inv:
                target = workspace / str(inv["deleteFile"])
                if target.exists():
                    target.unlink()
            res = runner.invoke(inv["args"])
            assert res.exit_code == inv["expectExitCode"], (
                f"{scenario['id']} {inv['args']}: stdout={res.stdout!r} stderr={res.stderr!r}"
            )
            for text in inv.get("expectStdoutContains", []):
                assert text in res.stdout
            for text in inv.get("expectStdoutNotContains", []):
                assert text not in res.stdout
            for text in inv.get("expectStderrContains", []):
                assert text in res.stderr
            if "expectJson" in inv:
                _assert_expected_json(res.stdout, inv["expectJson"])
