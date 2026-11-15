---
id: doc-6
title: Pixi sandbox offline setup
type: guide
created_date: '2026-11-15T00:50:00Z'
---

# Pixi sandbox offline setup

The project uses pixi-sandbox 0.9.0 via Pixi. `pixi-sandbox.toml` declares the
`developer` bundle, default environment and `linux-64` platform. The generated
publisher targets `sandbox/developer-linux-64`. Generated files are
`.github/workflows/publish-sandbox.yml`, `.github/workflows/relock.yml` and
`scripts/restore.sh`.

```sh
pixi install --locked
pixi run sandbox-plan
pixi run sandbox-check
# Regenerate after changing the sandbox config:
pixi run sandbox-init
```

The publisher is configured to run on pushes to main and manual dispatch; it
packs, verifies and publishes an orphan branch. Its weekly schedule runs the
upgrade job instead. It needs repository permissions and a real remote. The
relock workflow may commit a refreshed `pixi.lock` to a same-repository PR and
dispatch CI and the publisher; fork PRs cannot use that write path. It does
not relock `bun.lock`. Review these generated workflows before enabling them.

After an authorized publication succeeds, fetch or otherwise transfer the
sandbox branch into the target Git repository, then run:

```sh
PIXI_SANDBOX_FETCH=skip bash scripts/restore.sh
pixi install --frozen --offline
```

The launcher requires a Git checkout and an available matching sandbox branch.
Without `PIXI_SANDBOX_FETCH=skip` it fetches `sandbox/developer-linux-64` from
origin when the branch is missing. Restore of the `default` Pixi environment
has been verified in sandboxed runs (`pixi install --frozen --offline` is a
no-op afterwards). Note that the `local` Pixi environment (which includes the
editable `packages/tasknest-py` path dependency) is intentionally excluded from
`pixi-sandbox.toml` because native packing only carries wheel PyPI
dependencies. Likewise, Bun `node_modules` and `bun install` caches are not part
of the Pixi sandbox bundle; a fully offline Backlog/skills/TS-tooling setup needs
pre-populated `node_modules` or a local Bun cache. No Windows launcher or
platform bundle is configured.

See the [pixi-sandbox restore guide](https://archont561.github.io/pixi-sandbox/restore/).
