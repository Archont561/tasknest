# Python and TypeScript Conformance Suite

`conformance/scenarios.json` defines shared behavioral contract scenarios executed by both:

- `packages/tasknest-py/tests/test_conformance.py`
- `packages/tasknest-ts/tests/conformance.test.ts`

## Intentional Python vs. TypeScript Differences

1. **Task registration & option typing**:
   - Python (`@tool`) infers CLI options from function parameter annotations (`inspect.signature` + `get_type_hints`).
   - TypeScript (`tool({ options }, handler)`) declares CLI options explicitly in `ToolConfig.options` because TypeScript type annotations are erased at runtime.
2. **Task handler parameter format**:
   - Python prints booleans as `True`/`False` in f-strings; the conformance harness normalizes printed booleans to lowercase (`true`/`false`) when comparing shared outputs.
3. **Optional Jinja skill dependency**:
   - Python uses `jinja2` via optional extra `tasknest[skill]` (`tox` tests both `core` without `jinja2` and `skill` with `jinja2`).
   - TypeScript uses `@huggingface/jinja` via optional `peerDependencies`.
4. **Runtime host adapters**:
   - TypeScript routes TOML parsing, spawning, and process execution through `RuntimeAdapter` (`createBunAdapter` / `createNodeAdapter`) so both Bun (`>=1.1`) and Node.js (`>=20`) execute natively.
5. **Diagnostic phrasing**:
   - Informational summary lines (such as `check` output) follow each runner's conventions while sharing exit codes (`0` success, `1` task/drift failure, `2` usage/config/discovery/validation/graph error).
