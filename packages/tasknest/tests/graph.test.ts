import { join } from "node:path";
import {
  createTaskRegistry,
  type DiscoveredTask,
  discoverTasks,
  type TaskRegistry,
} from "@/src/discovery";
import { DependencyError, ToolError } from "@/src/errors";
import { executePlan, resolvePlan, validateGraph } from "@/src/graph";
import { type TaskHandler, tool } from "@/src/task";
import { expect, test, type WorkspaceHelper } from "@/tests/test";

const TASKNEST_SRC = join(import.meta.dir, "..", "src", "index.ts");

function makeRegistry(
  defs: Array<{ name: string; depends?: string[]; handler?: TaskHandler }>,
): TaskRegistry {
  const tasks: Record<string, DiscoveredTask> = {};
  for (const item of defs) {
    tasks[item.name] = {
      canonicalName: item.name,
      cliPath: item.name.split("."),
      definition: tool(
        { name: item.name, depends: item.depends ?? [] },
        item.handler ?? (async () => {}),
      ),
      sourcePath: `${item.name}.ts`,
      projectRoot: ".",
      description: "",
    };
  }
  return createTaskRegistry({ repoRoot: ".", roots: [], marks: {}, jobs: 1 }, tasks);
}

test
  .scenario("Unknown dependencies and cycles fail graph validation")
  .given("registries with a missing dependency and a cycle", () => ({
    missing: makeRegistry([{ name: "build", depends: ["missing.task"] }]),
    cycle: makeRegistry([
      { name: "a", depends: ["b"] },
      { name: "b", depends: ["a"] },
    ]),
  }))
  .when("validating both graphs", ({ missing, cycle }) => {
    let missingErr: unknown;
    try {
      validateGraph(missing);
    } catch (err) {
      missingErr = err;
    }
    let cycleErr: unknown;
    try {
      validateGraph(cycle);
    } catch (err) {
      cycleErr = err;
    }
    return { missingErr, cycleErr };
  })
  .then(
    "DependencyError describes the missing task and cycle",
    ({ missingErr, cycleErr, expect: assert }) => {
      assert(missingErr).toBeInstanceOf(DependencyError);
      assert(String(missingErr)).toContain("missing.task");
      assert(cycleErr).toBeInstanceOf(DependencyError);
      assert(String(cycleErr)).toContain("cycle");
    },
  );

test
  .scenario("Diamond dependency graph executes shared base task once")
  .given("a diamond dependency graph", () => {
    const calls: string[] = [];
    const registry = makeRegistry([
      {
        name: "base",
        handler: async () => {
          calls.push("base");
        },
      },
      {
        name: "left",
        depends: ["base"],
        handler: async () => {
          calls.push("left");
        },
      },
      {
        name: "right",
        depends: ["base"],
        handler: async () => {
          calls.push("right");
        },
      },
      {
        name: "top",
        depends: ["left", "right"],
        handler: async () => {
          calls.push("top");
        },
      },
    ]);
    return { calls, registry };
  })
  .when("executing top", async ({ registry }) => ({
    report: await executePlan(registry, "top"),
  }))
  .then("base runs once before left, right, and top", ({ calls, report, expect: assert }) => {
    assert(report.exitCode).toBe(0);
    assert(report.executed).toEqual(["base", "left", "right", "top"]);
    assert(calls).toEqual(["base", "left", "right", "top"]);
  });

test
  .scenario("Prerequisite failure blocks downstream tasks")
  .given("a linear dependency chain where base fails", () => {
    const calls: string[] = [];
    const registry = makeRegistry([
      {
        name: "base",
        handler: async () => {
          calls.push("base");
          throw new ToolError("base failed");
        },
      },
      {
        name: "mid",
        depends: ["base"],
        handler: async () => {
          calls.push("mid");
        },
      },
      {
        name: "top",
        depends: ["mid"],
        handler: async () => {
          calls.push("top");
        },
      },
    ]);
    return { calls, registry };
  })
  .when("executing top", async ({ registry }) => ({
    report: await executePlan(registry, "top"),
  }))
  .then("downstream tasks are blocked and exit code is 1", ({ calls, report, expect: assert }) => {
    assert(report.exitCode).toBe(1);
    assert(report.failedTask).toBe("base");
    assert(report.blocked).toEqual(["mid", "top"]);
    assert(calls).toEqual(["base"]);
  });

test.prop(
  "resolvePlan produces topological order without duplicates for any DAG",
  (fc) => ({
    edges: fc.array(fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }), {
      minLength: 5,
      maxLength: 5,
    }),
  }),
  async (_fixtures, { edges }) => {
    const names = ["t0", "t1", "t2", "t3", "t4"];
    const defs = names.map((name, i) => ({
      name,
      depends: names.filter((_, j) => j < i && edges[i]?.[j]),
    }));
    const registry = makeRegistry(defs);
    const plan = resolvePlan(registry, "t4");
    expect(new Set(plan).size).toBe(plan.length);
    expect(plan.at(-1)).toBe("t4");
    const pos = new Map(plan.map((n, idx) => [n, idx]));
    for (const item of defs) {
      const targetIdx = pos.get(item.name);
      if (targetIdx === undefined) {
        continue;
      }
      for (const dep of item.depends) {
        const depIdx = pos.get(dep);
        expect(depIdx).toBeDefined();
        if (depIdx !== undefined) {
          expect(depIdx).toBeLessThan(targetIdx);
        }
      }
    }
  },
  { numRuns: 30 },
);

test("TaskDefinition reference dependencies resolve across discovered modules", async ({
  workspace,
}) => {
  const ws = workspace as WorkspaceHelper;
  ws.writeToml({ discovery: { roots: [{ path: "tools", namespace: "" }] } });
  ws.writeFile(
    "tools/alpha.ts",
    `import { tool } from ${JSON.stringify(TASKNEST_SRC)};\n` +
      `import zeta from "./zeta.ts";\n` +
      `export default tool({ name: "alpha", depends: [zeta] }, async () => {});\n`,
  );
  ws.writeFile(
    "tools/zeta.ts",
    `import { tool } from ${JSON.stringify(TASKNEST_SRC)};\n` +
      `export default tool({ name: "zeta" }, async () => {});\n`,
  );

  const registry = await discoverTasks(ws.root);
  const report = await executePlan(registry, "alpha");
  expect(report.exitCode).toBe(0);
  expect(report.executed).toEqual(["zeta", "alpha"]);
});
