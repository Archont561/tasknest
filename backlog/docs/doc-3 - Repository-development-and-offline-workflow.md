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
pixi run tools list
pixi run tools check
pixi run tools test
pixi run hooks-install
```

`tools/dodo.py` is the repository's temporary doit graph; private helper modules under `tools/` follow `_*.py` as enforced by `.alint.yml`. `templates/README.md.j2` and `templates/AGENTS.md.j2` are sources for generated docs; `pixi run tools docs-write` updates them and the check gate verifies drift. Quality checks run `alint`, `pixi-sandbox init --check`, Ruff (`py310` target), Rude (`rude-clean-code`), mypy (`--strict`), Biome, TypeScript (`tsc --noEmit`), and `actionlint`. `pixi run tools py-compat` builds `packages/python` wheel and sdist artifacts, verifies metadata, and runs isolated installs; `pixi run tools ts-compat` builds and packs `packages/tasknest` and runs `publint`, `attw`, and isolated consumer checks. `pixi run backlog` invokes Backlog.md; `pixi run skills` invokes the installed skills CLI. Bun packages are pinned by `bun.lock`.

Python package tests and the Bun package smoke test execute via doit. Tox tests built wheels (both zero-dependency core and `[skill]` extra) across Python 3.10–3.14, and CI verifies the packed TypeScript tarball across Bun (`1.1`, `1.4`, `latest`) and Node.js LTS (`20`, `22`, `24`); only Python 3.12 and Bun 1.4 have been tested in this workspace. GitHub CI and installed hooks have not been proven on a hosted runner or real Git commit respectively.

pixi-sandbox configuration and generated launchers exist, but no sandbox branch or network-isolated end-to-end restore has been proven. Requirements and limits are described in `backlog/docs/doc-6 - Pixi-sandbox-offline-setup.md`.
