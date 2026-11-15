# Offline sandbox (orphan branch)

Built 2026-11-15T19:47:24Z from commit `ecdcbcf` for platform `linux-64`.
`pixi.lock` sha256 `23de4cd2755f1845f5cb95487f9a76e5e78c749e570ca1e5c0313e4cbfb63832`.

The verified self-bootstrap binary is stored at `.pixi-sandbox/tools/linux-64/pixi-sandbox`. The branch root intentionally contains documentation only.

| env | platform | packed | unpacked | files |
| --- | --- | ---: | ---: | ---: |
| `default` | linux-64 | 141.1 MiB | 429.6 MiB | 84 |


## Restore on the disconnected machine

```bash
./.pixi-sandbox/tools/linux-64/pixi-sandbox doctor --branch-location . --verify
./.pixi-sandbox/tools/linux-64/pixi-sandbox restore --branch-location . --output-path <project> --force
# then, from <project> with no network, use pixi as the sole entrypoint:
pixi install --frozen --offline
pixi run --frozen -- cargo build --offline
```

Every manifest blob is verified before it is written into the working tree.
