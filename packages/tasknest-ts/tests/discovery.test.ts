import { join } from "node:path";
import { discoverTasks } from "@/src/discovery";
import { DiscoveryError } from "@/src/errors";
import { test, type WorkspaceHelper } from "@/tests/test";

const TASKNEST_SRC = join(import.meta.dir, "..", "src", "index.ts");

function writeTaskFile(
  ws: WorkspaceHelper,
  relPath: string,
  fnName: string,
  description: string,
): void {
  ws.writeFile(
    relPath,
    `import { tool } from ${JSON.stringify(TASKNEST_SRC)};\n` +
      `export default tool({ name: ${JSON.stringify(fnName)}, description: ${JSON.stringify(description)} }, async () => {});\n`,
  );
}

test
  .scenario("Nested task files derive canonical names and CLI paths")
  .given("a configured root with a nested task file", ({ workspace }) => {
    const ws = workspace as WorkspaceHelper;
    ws.writeToml({ discovery: { roots: [{ path: "tools", namespace: "repo" }] } });
    writeTaskFile(ws, "tools/check/dev.ts", "dev", "Run dev checks.");
    return { ws };
  })
  .when("tasks are discovered for the workspace", async ({ ws }) => ({
    registry: await discoverTasks(ws.root),
  }))
  .then("the canonical name and CLI path include the namespace", ({ registry, expect: assert }) => {
    const task = registry.tasks["repo.check.dev"];
    assert(task).toBeDefined();
    assert(task?.cliPath).toEqual(["repo", "check", "dev"]);
    assert(task?.description).toBe("Run dev checks.");
  });

test
  .scenario("Underscore files and reserved directories are ignored during discovery")
  .given("a root with valid, underscore, and reserved directory files", ({ workspace }) => {
    const ws = workspace as WorkspaceHelper;
    ws.writeToml({ discovery: { roots: [{ path: "tools", namespace: "" }] } });
    writeTaskFile(ws, "tools/lint.ts", "lint", "Lint workspace.");
    ws.writeFile("tools/_helper.ts", "export const X = 1;\n");
    ws.writeFile("tools/_hidden/ignored.ts", "export const Y = 1;\n");
    ws.writeFile("tools/tests/test_lint.ts", "export const Z = 1;\n");
    ws.writeFile("tools/features/steps.ts", "export const W = 1;\n");
    return { ws };
  })
  .when("tasks are discovered for the workspace", async ({ ws }) => ({
    registry: await discoverTasks(ws.root),
  }))
  .then("only the non-ignored task is registered", ({ registry, expect: assert }) => {
    assert(Object.keys(registry.tasks)).toEqual(["lint"]);
  });

test
  .scenario("Files without or with multiple tool definitions fail discovery")
  .given("a root containing an empty file and a multi-tool file", ({ workspace }) => {
    const ws = workspace as WorkspaceHelper;
    ws.writeToml({ discovery: { roots: [{ path: "tools", namespace: "" }] } });
    ws.writeFile("tools/empty.ts", "export const VALUE = 1;\n");
    return { ws };
  })
  .when("discovery runs on the invalid file", async ({ ws }) => {
    let emptyErr: unknown;
    try {
      await discoverTasks(ws.root);
    } catch (err) {
      emptyErr = err;
    }
    ws.writeFile(
      "tools/empty.ts",
      `import { tool } from ${JSON.stringify(TASKNEST_SRC)};\n` +
        `export const one = tool({ name: "one" }, async () => {});\n` +
        `export const two = tool({ name: "two" }, async () => {});\n`,
    );
    let multiErr: unknown;
    try {
      await discoverTasks(ws.root);
    } catch (err) {
      multiErr = err;
    }
    return { emptyErr, multiErr };
  })
  .then(
    "both fail with DiscoveryError explaining one tool per file",
    ({ emptyErr, multiErr, expect: assert }) => {
      assert(emptyErr).toBeInstanceOf(DiscoveryError);
      assert(String(emptyErr)).toContain("exactly one");
      assert(multiErr).toBeInstanceOf(DiscoveryError);
      assert(String(multiErr)).toContain("exactly one");
    },
  );

test
  .scenario("Duplicate canonical names across roots fail discovery")
  .given("two configured roots defining the same canonical task path", ({ workspace }) => {
    const ws = workspace as WorkspaceHelper;
    ws.writeToml({
      discovery: {
        roots: [
          { path: "tools_a", namespace: "" },
          { path: "tools_b", namespace: "" },
        ],
      },
    });
    writeTaskFile(ws, "tools_a/lint.ts", "lint", "Lint A.");
    writeTaskFile(ws, "tools_b/lint.ts", "lint", "Lint B.");
    return { ws };
  })
  .when("tasks are discovered", async ({ ws }) => {
    try {
      await discoverTasks(ws.root);
      return { error: undefined as unknown };
    } catch (error) {
      return { error };
    }
  })
  .then("DiscoveryError names the duplicate canonical task", ({ error, expect: assert }) => {
    assert(error).toBeInstanceOf(DiscoveryError);
    assert(String(error)).toContain("Duplicate task name");
    assert(String(error)).toContain("lint");
  });
