import { resolve } from "node:path";
import type { FastCheckApi } from "@archont561/bun-test-utils/pbt";
import { loadConfig } from "@/src/config";
import { ConfigError } from "@/src/errors";
import { createNodeAdapter } from "@/src/node-adapter";
import { expect, test, type WorkspaceHelper } from "@/tests/test";

test("loadConfig returns defaults when tasknest.toml is absent", ({ workspace }) => {
  const ws = workspace as WorkspaceHelper;
  const cfg = loadConfig(ws.root);
  expect(cfg.repoRoot).toBe(resolve(ws.root));
  expect(cfg.roots).toEqual([{ path: "tools", namespace: "", projectRoot: "." }]);
  expect(cfg.marks).toEqual({});
  expect(cfg.jobs).toBe(1);
});

test("loadConfig rejects missing explicit path, invalid TOML, and non-positive jobs", ({
  workspace,
}) => {
  const ws = workspace as WorkspaceHelper;
  expect(() => loadConfig(ws.root, { configPath: "missing.toml" })).toThrow(ConfigError);

  const badToml = ws.writeFile("bad.toml", "not = [valid");
  expect(() => loadConfig(ws.root, { configPath: badToml })).toThrow(ConfigError);

  const badJobs = ws.writeToml({ execution: { jobs: 0 } }, "bad_jobs.toml");
  expect(() => loadConfig(ws.root, { configPath: badJobs })).toThrow(ConfigError);
});

test("loadConfig parses tasknest.toml with Node adapter via smol-toml", ({ workspace }) => {
  const ws = workspace as WorkspaceHelper;
  ws.writeToml({ tasknest: { config_version: 1 }, execution: { jobs: 2 } });
  const cfg = loadConfig(ws.root, { adapter: createNodeAdapter() });
  expect(cfg.jobs).toBe(2);
});

const identArb = (fc: FastCheckApi) => fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/);

test.prop(
  "loadConfig parses generated tasknest.toml configurations",
  (fc) => ({
    rootPaths: fc.array(identArb(fc), { minLength: 1, maxLength: 3 }),
    namespaces: fc.array(identArb(fc), { minLength: 1, maxLength: 3 }),
    marks: fc.dictionary(identArb(fc), fc.string({ minLength: 1, maxLength: 24 }), {
      maxKeys: 4,
    }),
    jobs: fc.integer({ min: 1, max: 16 }),
  }),
  async ({ workspace }, { rootPaths, namespaces, marks, jobs }) => {
    const ws = workspace as WorkspaceHelper;
    const count = Math.min(rootPaths.length, namespaces.length);
    const expectedRoots = Array.from({ length: count }, (_, i) => ({
      path: rootPaths[i] as string,
      namespace: namespaces[i] as string,
      projectRoot: ".",
    }));

    const payload: Record<string, unknown> = {
      tasknest: { config_version: 1 },
      execution: { jobs },
      discovery: {
        roots: expectedRoots.map((r) => ({
          path: r.path,
          namespace: r.namespace,
          project_root: r.projectRoot,
        })),
      },
    };
    if (Object.keys(marks).length > 0) {
      payload.marks = marks;
    }

    ws.writeToml(payload);
    const cfg = loadConfig(ws.root);
    expect(cfg.roots).toEqual(expectedRoots);
    expect(cfg.marks).toEqual(marks);
    expect(cfg.jobs).toBe(jobs);
  },
  { numRuns: 25 },
);
