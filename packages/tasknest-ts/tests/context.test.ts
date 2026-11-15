import { CommandResult, ToolContext } from "@/src/context";
import { ToolError } from "@/src/errors";
import { createNodeAdapter } from "@/src/node-adapter";
import { test, type WorkspaceHelper } from "@/tests/test";

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
