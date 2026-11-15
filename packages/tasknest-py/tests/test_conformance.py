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


def _render_python_task(task: dict[str, Any]) -> str:
    lines = [
        "from pathlib import Path",
        "from typing import Literal",
        "from tasknest import ToolError, tool",
        "",
        "@tool(",
        f"    name={task['name']!r},",
        f"    depends={task.get('depends', [])!r},",
        f"    marks={task.get('marks', [])!r},",
        f"    requires={task.get('requires', [])!r},",
        f"    description={task.get('description', '')!r},",
        ")",
    ]
    params: list[str] = []
    for opt in task.get("options", []):
        ann = _py_type_expr(opt)
        default = opt.get("default")
        params.append(f"{opt['name']}: {ann} = {default!r}")
    lines.append(f"def {task['name']}({', '.join(params)}) -> None:")
    if task.get("failMessage"):
        lines.append(f"    raise ToolError({task['failMessage']!r})")
    else:
        for msg in task.get("prints", []):
            rendered = str(msg)
            for opt in task.get("options", []):
                name = str(opt["name"])
                expr = f"(str({name}).lower() if isinstance({name}, bool) else {name})"
                rendered = rendered.replace("{{" + name + "}}", "{" + expr + "}")
            lines.append(f"    print(f{rendered!r})")
        if not task.get("prints"):
            lines.append("    pass")
    return "\n".join(lines) + "\n"


def _load_scenarios() -> list[dict[str, Any]]:
    payload = json.loads(_SCENARIOS_PATH.read_text(encoding="utf-8"))
    return list(payload["scenarios"])


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
