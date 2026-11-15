# Tasknest

> Scaffold for native Python and TypeScript task runners.

Tasknest is a proposed file-based task runner. This repository currently provides
repository automation and package scaffolds, **not the task runner itself**.

## Development

Install [Pixi](https://pixi.sh/), then run:

```sh
pixi install --locked
pixi run bun-install
pixi run tools check
pixi run tools test
pixi run hooks-install
```

`pixi run tools` uses doit, not the future Tasknest runner. List tasks with
`pixi run tools list`. Use
`pixi run tools docs-write` after editing templates; CI runs `docs-check`.
Python compatibility environments are defined in `tox.ini`. Bun installs the pinned
repository CLIs from `bun.lock`; invoke them using `pixi run skills` and
`pixi run backlog`.

## Layout

- `packages/python/` and `packages/tasknest/`: native runner scaffolds.
- `tools/dodo.py`: doit task graph and repository automation.
- `templates/`: sources for this README and `AGENTS.md`.
- `tasknest.toml`: proposed future runner configuration, not consumed yet.
- `pixi-sandbox.toml`: offline sandbox configuration; see [offline setup](<backlog/docs/doc-6 - Pixi-sandbox-offline-setup.md>).

## Planning

Project decisions, specifications and milestones live in [`backlog/`](backlog/).
Use `pixi run backlog task list --plain` to inspect the current plan.

## License

MIT; see [LICENSE](LICENSE).
