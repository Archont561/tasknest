import { stringify } from "smol-toml";
import { createBunAdapter } from "@/src/bun-adapter";
import { ConfigError } from "@/src/errors";
import { expect, test } from "@/tests/test";

test
  .scenario("Bun adapter parses valid TOML and captures subprocess output")
  .given("a Bun runtime adapter", () => ({ adapter: createBunAdapter() }))
  .when("parsing valid TOML configuration", ({ adapter }) => ({
    parsed: adapter.parseToml("[tasknest]\nconfig_version = 1\n[execution]\njobs = 3\n"),
  }))
  .then("parsed fields match the TOML document", ({ parsed, expect: assert }) => {
    assert(parsed).toEqual({
      tasknest: { config_version: 1 },
      execution: { jobs: 3 },
    });
  });

test("Bun adapter rejects malformed TOML with ConfigError", () => {
  const adapter = createBunAdapter();
  expect(() => adapter.parseToml("not = [valid")).toThrow(ConfigError);
});

test.prop(
  "Bun adapter round-trips generated TOML tables",
  (fc) => ({
    jobs: fc.integer({ min: 1, max: 32 }),
    rootPath: fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/),
    namespace: fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/),
  }),
  async ({ workspace }, { jobs, rootPath, namespace }) => {
    const adapter = createBunAdapter();
    const doc = {
      execution: { jobs },
      discovery: { roots: [{ path: rootPath, namespace }] },
    };
    const parsed = adapter.parseToml(stringify(doc));
    expect(parsed).toEqual(doc);
    const proc = adapter.spawn([process.execPath, "-e", "console.log('ok')"], {
      cwd: (workspace as { root: string }).root,
      capture: true,
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.trim()).toBe("ok");
  },
  { numRuns: 20 },
);

test("Bun adapter spawnAsync streams lines and cancels cleanly via AbortSignal", async ({
  workspace,
}) => {
  const adapter = createBunAdapter();
  const spawnAsync = adapter.spawnAsync;
  expect(spawnAsync).toBeDefined();
  const lines: string[] = [];
  const controller = new AbortController();
  const res = await spawnAsync?.(
    [
      process.execPath,
      "-e",
      'console.log("BUN_1"); setTimeout(() => console.log("BUN_2"), 10000);',
    ],
    {
      cwd: (workspace as { root: string }).root,
      signal: controller.signal,
      onStdoutLine: (line) => {
        lines.push(line.trim());
        if (line.includes("BUN_1")) {
          controller.abort();
        }
      },
    },
  );
  expect(res?.cancelled).toBe(true);
  expect(lines).toContain("BUN_1");
  expect(lines).not.toContain("BUN_2");
});
