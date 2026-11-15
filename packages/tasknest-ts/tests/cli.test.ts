import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "@/src/cli";
import { createNodeAdapter } from "@/src/node-adapter";
import { expect, test, type WorkspaceHelper } from "@/tests/test";

const TASKNEST_SRC = join(import.meta.dir, "..", "src", "index.ts");

function createCliWorkspace(ws: WorkspaceHelper): void {
  ws.writeToml({ discovery: { roots: [{ path: "tools", namespace: "" }] } });
  ws.writeFile(
    "tools/check.ts",
    `import { appendFileSync } from "node:fs";\n` +
      `import { join } from "node:path";\n` +
      `import { tool } from ${JSON.stringify(TASKNEST_SRC)};\n` +
      `export default tool({ name: "check", description: "Run base checks." }, async (ctx) => {\n` +
      `  appendFileSync(join(ctx.projectRoot, "events.log"), "CHECK_OK\\n", "utf-8");\n` +
      `});\n`,
  );
  ws.writeFile(
    "tools/lint.ts",
    `import { appendFileSync } from "node:fs";\n` +
      `import { join } from "node:path";\n` +
      `import { tool } from ${JSON.stringify(TASKNEST_SRC)};\n` +
      `export default tool(\n` +
      `  {\n` +
      `    name: "lint",\n` +
      `    depends: ["check"],\n` +
      `    description: "Lint files.",\n` +
      `    options: [\n` +
      `      { name: "path", type: "path", default: "." },\n` +
      `      { name: "dry_run", type: "boolean", default: false },\n` +
      `      { name: "jobs", type: "int", default: 1 },\n` +
      `    ],\n` +
      `  },\n` +
      `  async (ctx, args) => {\n` +
      `    appendFileSync(join(ctx.projectRoot, "events.log"), \`LINT:\${String(args.path)}:\${String(args.dry_run)}:\${String(args.jobs)}\\n\`, "utf-8");\n` +
      `  },\n` +
      `);\n`,
  );
  ws.writeFile(
    "tools/a.ts",
    `import { appendFileSync } from "node:fs";\n` +
      `import { join } from "node:path";\n` +
      `import { tool } from ${JSON.stringify(TASKNEST_SRC)};\n` +
      `export default tool({ name: "a", description: "Parent task." }, async (ctx, _args, pos) => {\n` +
      `  appendFileSync(join(ctx.projectRoot, "events.log"), \`A:\${pos.join(",")}\\n\`, "utf-8");\n` +
      `});\n`,
  );
  ws.writeFile(
    "tools/a/b.ts",
    `import { appendFileSync } from "node:fs";\n` +
      `import { join } from "node:path";\n` +
      `import { tool } from ${JSON.stringify(TASKNEST_SRC)};\n` +
      `export default tool({ name: "b", description: "Nested child task." }, async (ctx) => {\n` +
      `  appendFileSync(join(ctx.projectRoot, "events.log"), "B_RAN\\n", "utf-8");\n` +
      `});\n`,
  );
}

async function invokeCli(
  args: string[],
  ws: WorkspaceHelper,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, {
    cwd: ws.root,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

function readEvents(ws: WorkspaceHelper): string {
  return readFileSync(join(ws.root, "events.log"), "utf-8");
}

test
  .scenario("CLI lists, checks, plans, and runs tasks without separator")
  .given("a workspace with dependent tasks", ({ workspace }) => {
    const ws = workspace as WorkspaceHelper;
    createCliWorkspace(ws);
    return { ws };
  })
  .when("invoking ls, check, plan, and run", async ({ ws }) => {
    const lsRes = await invokeCli(["--root", ws.root, "ls"], ws);
    const checkRes = await invokeCli(["--root", ws.root, "check"], ws);
    const planRes = await invokeCli(["--root", ws.root, "plan", "lint"], ws);
    const runRes = await invokeCli(
      ["--root", ws.root, "run", "lint", "--path", "src", "--dry-run"],
      ws,
    );
    return { lsRes, checkRes, planRes, runRes, events: readEvents(ws) };
  })
  .then(
    "all commands succeed and print expected output",
    ({ lsRes, checkRes, planRes, runRes, events, expect: assert }) => {
      assert(lsRes.code).toBe(0);
      assert(lsRes.stdout).toContain("lint");
      assert(lsRes.stdout).toContain("Lint files.");
      assert(checkRes.code).toBe(0);
      assert(planRes.code).toBe(0);
      assert(planRes.stdout).toContain("check");
      assert(planRes.stdout).toContain("lint");
      assert(runRes.code).toBe(0);
      assert(events).toContain("CHECK_OK");
      assert(events).toContain("LINT:src:true:1");
    },
  );

test
  .scenario("Longest prefix wins over positional unless disambiguated with --")
  .given("tasks a and a.b sharing prefix a", ({ workspace }) => {
    const ws = workspace as WorkspaceHelper;
    createCliWorkspace(ws);
    return { ws };
  })
  .when("running both a b and a -- b", async ({ ws }) => ({
    nested: await invokeCli(["--root", ws.root, "run", "a", "b"], ws),
    positional: await invokeCli(["--root", ws.root, "run", "a", "--", "b"], ws),
    events: readEvents(ws),
  }))
  .then(
    "a b invokes a.b while a -- b passes b positionally to a",
    ({ nested, positional, events, expect: assert }) => {
      assert(nested.code).toBe(0);
      assert(positional.code).toBe(0);
      assert(events).toContain("B_RAN");
      assert(events).toContain("A:b");
    },
  );

test("CLI isolates global options before subcommand and prints version", async ({ workspace }) => {
  const ws = workspace as WorkspaceHelper;
  createCliWorkspace(ws);

  const ver = await invokeCli(["--version"], ws);
  expect(ver.code).toBe(0);
  expect(ver.stdout).toContain("tasknest");

  const globalAfter = await invokeCli(["--root", ws.root, "run", "check", "--verbose"], ws);
  expect(globalAfter.code).toBe(2);
  expect(globalAfter.stderr).toContain("Unknown option");
});

test("CLI executes ls cleanly when Node adapter loads tasknest.toml", async ({ workspace }) => {
  const ws = workspace as WorkspaceHelper;
  createCliWorkspace(ws);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(["--root", ws.root, "ls"], {
    cwd: ws.root,
    adapter: createNodeAdapter(),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  expect(code).toBe(0);
  expect(err).toEqual([]);
  expect(out.join("\n")).toContain("lint");
});

test.prop(
  "CLI forwards typed integer task flags",
  (fc) => ({ jobs: fc.integer({ min: 1, max: 16 }) }),
  async ({ workspace }, { jobs }) => {
    const ws = workspace as WorkspaceHelper;
    createCliWorkspace(ws);
    const res = await invokeCli(["--root", ws.root, "run", "lint", "--jobs", String(jobs)], ws);
    expect(res.code).toBe(0);
    expect(readEvents(ws)).toContain(`LINT:.:false:${jobs}`);
  },
  { numRuns: 8 },
);
