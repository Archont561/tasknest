import { CommandResult, ToolContext } from "@/src/context";
import { ToolError } from "@/src/errors";
import { createNodeAdapter } from "@/src/node-adapter";
import { expect, test, type WorkspaceHelper } from "@/tests/test";

test
  .scenario("Command defaults to projectRoot when repoRoot differs")
  .given("a ToolContext with repoRoot and nested projectRoot", ({ workspace }) => {
    const ws = workspace as WorkspaceHelper;
    const projectRoot = ws.mkdir("packages/app");
    return {
      projectRoot,
      ctx: new ToolContext({
        repoRoot: ws.root,
        projectRoot,
        taskName: "check",
      }),
    };
  })
  .when("running a process that prints cwd", ({ ctx }) => ({
    result: ctx.run([process.execPath, "-e", "process.stdout.write(process.cwd())"], {
      capture: true,
    }),
  }))
  .then("the working directory matches projectRoot", ({ projectRoot, result, expect: assert }) => {
    assert(result).toBeInstanceOf(CommandResult);
    assert(result.stdout).toBe(projectRoot);
  });

test
  .scenario("Environment overrides merge with inherited environment")
  .given("a ToolContext with an inherited environment", ({ workspace, env }) => {
    const ws = workspace as WorkspaceHelper;
    const envHelper = env as { set(key: string, value: string): void };
    envHelper.set("TASKNEST_INHERITED", "yes");
    return {
      ctx: new ToolContext({
        repoRoot: ws.root,
        projectRoot: ws.root,
        taskName: "env-check",
      }),
    };
  })
  .when("running a process with an env override", ({ ctx }) => ({
    result: ctx.run(
      [
        process.execPath,
        "-e",
        "process.stdout.write([process.env.TASKNEST_INHERITED, process.env.TASKNEST_OVERRIDE].join(':'))",
      ],
      {
        env: { TASKNEST_OVERRIDE: "ok" },
        capture: true,
      },
    ),
  }))
  .then("both inherited and overridden variables are visible", ({ result, expect: assert }) => {
    assert(result.stdout).toBe("yes:ok");
  });

test
  .scenario("Shell string commands are rejected without executing")
  .given("a ToolContext", ({ workspace }) => {
    const ws = workspace as WorkspaceHelper;
    return {
      ctx: new ToolContext({
        repoRoot: ws.root,
        projectRoot: ws.root,
        taskName: "unsafe",
      }),
    };
  })
  .when("attempting to run a raw string command", ({ ctx }) => {
    try {
      ctx.run("echo hi" as unknown as readonly string[]);
      return { error: undefined as unknown };
    } catch (error) {
      return { error };
    }
  })
  .then("ToolError is raised explaining shell=false", ({ error, expect: assert }) => {
    assert(error).toBeInstanceOf(ToolError);
    assert(String(error)).toContain("explicit argv");
  });

test
  .scenario("Nonzero exit, timeouts, and missing executables raise ToolError")
  .given("a ToolContext using the Node adapter", ({ workspace }) => {
    const ws = workspace as WorkspaceHelper;
    return {
      ctx: new ToolContext({
        repoRoot: ws.root,
        projectRoot: ws.root,
        taskName: "failures",
        adapter: createNodeAdapter(),
      }),
    };
  })
  .when("running failing, timing-out, and missing commands", ({ ctx }) => {
    const unchecked = ctx.run([process.execPath, "-e", "process.exit(3)"], {
      check: false,
    });
    let nonzeroErr: unknown;
    try {
      ctx.run([process.execPath, "-e", "process.exit(3)"]);
    } catch (err) {
      nonzeroErr = err;
    }
    let timeoutErr: unknown;
    try {
      ctx.run([process.execPath, "-e", "setTimeout(() => {}, 2000)"], {
        timeoutSeconds: 0.05,
      });
    } catch (err) {
      timeoutErr = err;
    }
    let missingErr: unknown;
    try {
      ctx.run(["definitely-not-a-tasknest-executable-xyz"]);
    } catch (err) {
      missingErr = err;
    }
    return { unchecked, nonzeroErr, timeoutErr, missingErr };
  })
  .then(
    "each failure mode behaves per contract",
    ({ unchecked, nonzeroErr, timeoutErr, missingErr, expect: assert }) => {
      assert(unchecked.exitCode).toBe(3);
      assert(nonzeroErr).toBeInstanceOf(ToolError);
      assert(timeoutErr).toBeInstanceOf(ToolError);
      assert(String(timeoutErr)).toContain("timed out");
      assert(missingErr).toBeInstanceOf(ToolError);
    },
  );

test("ctx.output validates JSON serializability immediately and buffers until commit", ({
  workspace,
}) => {
  const ws = workspace as WorkspaceHelper;
  const ctx = new ToolContext({
    repoRoot: ws.root,
    projectRoot: ws.root,
    taskName: "producer",
  });
  expect(() => ctx.output(undefined)).toThrow(ToolError);
  expect(() => ctx.output({ bad: Number.NaN })).toThrow(ToolError);
  ctx.output({ b: 2, a: 1 });
  const committed = ctx.commitOutput();
  expect(committed).toBeDefined();
  expect(committed?.serialized).toBe('{"a":1,"b":2}');
});

test("ctx.deps restricts reads to declared dependencies and is read-only", ({ workspace }) => {
  const ws = workspace as WorkspaceHelper;
  const ctx = new ToolContext({
    repoRoot: ws.root,
    projectRoot: ws.root,
    taskName: "consumer",
    declaredDeps: ["prep", "silent"],
    depsOutputs: { prep: { artifact: "dist/out.js" } },
  });
  expect(ctx.deps.prep).toEqual({ artifact: "dist/out.js" });
  expect(ctx.deps.silent).toBeUndefined();
  expect(() => ctx.deps.undeclared).toThrow(ToolError);
  expect(() => {
    (ctx.deps as Record<string, unknown>).prep = "mutated";
  }).toThrow(ToolError);
});

test("ctx.env, setEnv, unsetEnv, and withEnv isolate task-local env without mutating process.env", async ({
  workspace,
}) => {
  const ws = workspace as WorkspaceHelper;
  const before = process.env.TASKNEST_LOCAL_ONLY;
  const ctx = new ToolContext({
    repoRoot: ws.root,
    projectRoot: ws.root,
    taskName: "env-local",
    env: { BASE_KEY: "base" },
  });
  expect(ctx.env("BASE_KEY")).toBe("base");
  ctx.setEnv("TASKNEST_LOCAL_ONLY", "scoped");
  expect(ctx.env("TASKNEST_LOCAL_ONLY")).toBe("scoped");
  expect(process.env.TASKNEST_LOCAL_ONLY).toBe(before);
  await ctx.withEnv({ TASKNEST_LOCAL_ONLY: "inner" }, () => {
    expect(ctx.env("TASKNEST_LOCAL_ONLY")).toBe("inner");
  });
  expect(ctx.env("TASKNEST_LOCAL_ONLY")).toBe("scoped");
  ctx.unsetEnv("TASKNEST_LOCAL_ONLY");
  expect(ctx.env("TASKNEST_LOCAL_ONLY", "fallback")).toBe("fallback");
  expect(ctx.accessedEnvKeys()).toEqual(["BASE_KEY", "TASKNEST_LOCAL_ONLY"]);
});
