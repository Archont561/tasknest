"""Verify built TypeScript package tarball compatibility in isolation."""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

_BUN = "bun"
_STRICT = "--strict"
_CHECK_FILE = "check.ts"
_UTF8 = "utf-8"
_CONSUMER_PKG = '{"name": "consumer", "type": "module"}\n'
_CONSUMER_TS = (
    'import { VERSION, version } from "tasknest";\n'
    'if (VERSION !== version || !VERSION.endsWith("-dev.0")) {\n'
    "  throw new Error(`Unexpected version: ${VERSION}`);\n"
    "}\n"
)


def _run(argv: tuple[str, ...], cwd: Path) -> bool:
    print("+ " + " ".join(argv), flush=True)
    return subprocess.run(argv, cwd=cwd, check=False).returncode == 0


def _tsc_cmd(tsc: str, module: str, resolution: str) -> tuple[str, ...]:
    return (
        tsc,
        "--noEmit",
        _STRICT,
        "--module",
        module,
        "--moduleResolution",
        resolution,
        _CHECK_FILE,
    )


def _verify_consumer(root: Path, tgz: Path, tmp_path: Path) -> bool:
    consumer = tmp_path / "consumer"
    consumer.mkdir()
    (consumer / "package.json").write_text(_CONSUMER_PKG, encoding=_UTF8)
    (consumer / _CHECK_FILE).write_text(_CONSUMER_TS, encoding=_UTF8)
    tsc = str(root / "node_modules/.bin/tsc")
    checks = (
        (_BUN, "add", "--prefer-offline", str(tgz)),
        (_BUN, "run", _CHECK_FILE),
        _tsc_cmd(tsc, "nodenext", "nodenext"),
        _tsc_cmd(tsc, "esnext", "bundler"),
    )
    return all(_run(cmd, consumer) for cmd in checks)


def verify_ts_compat(root: Path) -> bool:
    """Pack packages/tasknest and verify publint, attw, and consumer resolution."""
    ts_bin = root / "packages/tasknest/node_modules/.bin"
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        if not _run((_BUN, "pm", "pack", "--cwd", "packages/tasknest", "--destination", tmp), root):
            return False
        tgz = next(tmp_path.glob("tasknest-*.tgz"))
        gates = (
            (_BUN, str(ts_bin / "publint"), "run", str(tgz), _STRICT),
            (_BUN, str(ts_bin / "attw"), str(tgz), "--profile", "esm-only", "--no-emoji"),
        )
        return all(_run(cmd, root) for cmd in gates) and _verify_consumer(root, tgz, tmp_path)


if __name__ == "__main__":
    raise SystemExit(0 if verify_ts_compat(Path(__file__).resolve().parent.parent) else 1)
