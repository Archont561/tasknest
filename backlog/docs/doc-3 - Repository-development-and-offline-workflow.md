---
id: doc-3
title: Repository development and offline workflow
type: specification
created_date: '2026-11-15T00:46:00Z'
---

# Repository development and offline workflow

See the generated `README.md` and `backlog/docs/doc-6 - Pixi-sandbox-offline-setup.md` for the current authoritative commands and limitations.

```sh
pixi install --locked
pixi run bun-install
pixi run tools ls
pixi run tools check
pixi run tools run check
pixi run tools run test
pixi run hooks-install
```

`tools/*.py` is the repository's own Tasknest task graph; private helper modules under `tools/` follow `_*.py` as enforced by `.alint.yml`. `templates/README.md.j2` and `templates/AGENTS.md.j2` are sources for generated docs; `pixi run tools run docs_write` updates them and the `docs_check` gate verifies drift. Quality checks run `alint`, `pixi-sandbox init --check`, Ruff (`py310` target), Rude (`rude-clean-code`), gherlint, mypy (`--strict`), Biome, TypeScript (`tsc --noEmit`), and `actionlint`. `pixi run tools run py_compat` builds `packages/tasknest-py` wheel and sdist artifacts, verifies metadata, and runs isolated installs; `pixi run tools run ts_compat` builds and packs `packages/tasknest-ts` and runs `publint`, `attw`, and isolated consumer checks. `pixi run backlog` invokes Backlog.md; `pixi run skills` invokes the installed skills CLI. Bun packages are pinned by `bun.lock`, and the `local` Pixi environment adds `packages/tasknest-py` as an editable dependency (`pixi run -e local ...`) without affecting the wheel-only `default` environment packed by `pixi-sandbox`.

Python package tests and the Bun test suite execute via `pixi run tools run test`. Tox tests built wheels across Python 3.10–3.14, and GitHub CI verifies the packed TypeScript tarball across Bun (`1.1`, `1.4`, `latest`) and Node.js LTS (`20`, `22`, `24`).

`pixi-sandbox` configuration and generated launchers are published to `sandbox/developer-linux-64` and verified via `scripts/restore.sh` for the `default` Pixi environment (see `backlog/docs/doc-6 - Pixi-sandbox-offline-setup.md` for Bun/npm caveats).
