import { stringify } from "smol-toml";
import { ConfigError } from "@/src/errors";
import { createNodeAdapter } from "@/src/node-adapter";
import { expect, test } from "@/tests/test";

test
  .scenario("Node adapter parses valid TOML via smol-toml and runs subprocesses")
  .given("a Node runtime adapter", () => ({ adapter: createNodeAdapter() }))
  .when("parsing valid TOML configuration", ({ adapter }) => ({
    parsed: adapter.parseToml("[tasknest]\nconfig_version = 1\n[execution]\njobs = 3\n"),
  }))
  .then("parsed fields match the TOML document", ({ parsed, expect: assert }) => {
    assert(parsed).toEqual({
      tasknest: { config_version: 1 },
      execution: { jobs: 3 },
    });
  });

test("Node adapter rejects malformed TOML with ConfigError", () => {
  const adapter = createNodeAdapter();
  expect(() => adapter.parseToml("not = [valid")).toThrow(ConfigError);
});

test("Node adapter executes subprocesses via node:child_process", ({ workspace }) => {
  const adapter = createNodeAdapter();
  expect(adapter.runtime).toBe("node");

  const res = adapter.spawn([process.execPath, "-e", "process.stdout.write('node-ok')"], {
    cwd: workspace.root,
    capture: true,
  });
  expect(res.exitCode).toBe(0);
  expect(res.stdout).toBe("node-ok");
  expect(res.timedOut).toBe(false);
});

test.prop(
  "Node adapter round-trips generated TOML tables",
  (fc) => ({
    jobs: fc.integer({ min: 1, max: 32 }),
    rootPath: fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/),
    namespace: fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/),
  }),
  async (_fixtures, { jobs, rootPath, namespace }) => {
    const adapter = createNodeAdapter();
    const doc = {
      execution: { jobs },
      discovery: { roots: [{ path: rootPath, namespace }] },
    };
    expect(adapter.parseToml(stringify(doc))).toEqual(doc);
  },
  { numRuns: 20 },
);
