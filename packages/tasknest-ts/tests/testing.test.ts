import { join } from "node:path";
import { CliRunner, withIsolatedWorkspace } from "@/src/testing";
import { expect, test } from "@/tests/test";

const TASKNEST_SRC = join(import.meta.dir, "..", "src", "index.ts");
const BIN_PATH = join(import.meta.dir, "..", "src", "bin.ts");

test("CliRunner isolates workspace and captures exit code, stdout, stderr", async () => {
  await withIsolatedWorkspace(
    {
      "tools/hello.ts": [
        `import { tool } from ${JSON.stringify(TASKNEST_SRC)};`,
        `export default tool({ description: "Greet.", options: [{ name: "who", type: "string", default: "world" }] }, (_ctx, args) => {`,
        `  console.log("HELLO:" + String(args.who));`,
        `});`,
      ].join("\n"),
      "tools/fail.ts": [
        `import { ToolError, tool } from ${JSON.stringify(TASKNEST_SRC)};`,
        `export default tool({ description: "Fail." }, () => { throw new ToolError("boom", 3); });`,
      ].join("\n"),
    },
    async (workspace) => {
      const runner = new CliRunner(workspace);
      const ok = await runner.invoke(["run", "hello", "--who", "tasknest"]);
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout).toContain("HELLO:tasknest");
      expect(ok.stderr).toBe("");
      expect(ok.error).toBeUndefined();

      const bad = await runner.invoke(["run", "fail"]);
      expect(bad.exitCode).toBe(3);
      expect(bad.stderr).toContain("boom");
    },
  );
});

test("subprocess bin entrypoint runs isolated projects and reports failures", async () => {
  await withIsolatedWorkspace(
    {
      "tools/ok.ts": [
        `import { tool } from ${JSON.stringify(TASKNEST_SRC)};`,
        `export default tool({ description: "Pass." }, () => { console.log("SUBPROC_OK"); });`,
      ].join("\n"),
      "tools/broken.ts": [
        `import { ToolError, tool } from ${JSON.stringify(TASKNEST_SRC)};`,
        `export default tool({ description: "Fail." }, () => { throw new ToolError("subproc boom", 1); });`,
      ].join("\n"),
    },
    async (workspace) => {
      const okProc = Bun.spawnSync(["bun", BIN_PATH, "--root", workspace, "run", "ok"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(okProc.exitCode).toBe(0);
      expect(okProc.stdout.toString()).toContain("SUBPROC_OK");

      const failProc = Bun.spawnSync(["bun", BIN_PATH, "--root", workspace, "run", "broken"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(failProc.exitCode).toBe(1);
      expect(failProc.stderr.toString()).toContain("subproc boom");

      const usageProc = Bun.spawnSync(["bun", BIN_PATH, "--root", workspace, "run", "missing"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(usageProc.exitCode).toBe(2);
    },
  );
});
