# Agent instructions

- This is a scaffold: do not claim the task runner or its planned APIs exist.
- Install dependencies with Pixi and run `pixi run tools check` and `pixi run tools test`.
- Edit `templates/README.md.j2` or `templates/AGENTS.md.j2`, then run `pixi run tools docs-write`.
- Keep repository automation in `tools/dodo.py`. Do not confuse doit with Tasknest.
- Use `pixi run backlog task list --plain` and review `backlog/docs/` and decisions before changes.
- Do not publish packages, push branches, or mutate offline mirrors without authorization.
- Read `backlog/docs/doc-6 - Pixi-sandbox-offline-setup.md` before claiming offline restore works.
