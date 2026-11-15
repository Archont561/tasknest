import { join } from "node:path";
import { discoverTasks } from "@/src/discovery";
import { ValidationError } from "@/src/errors";
import { CliRunner, withIsolatedWorkspace } from "@/src/testing";
import { formatEffectSummary, selectTasksByMarks, validateRegistry } from "@/src/validation";
import { expect, test } from "@/tests/test";

const TASKNEST_SRC = join(import.meta.dir, "..", "src", "index.ts");

test("strict validation rejects unknown marks and missing descriptions", async () => {
  await withIsolatedWorkspace(
    {
      "tasknest.toml": [
        "[tasknest]",
        "config_version = 1",
        "[checks]",
        "strict = true",
        "require_description = true",
        "unknown_marks = 'error'",
        "[marks]",
        "fast = 'Fast'",
      ].join("\n"),
      "tools/bad.ts": `import { tool } from ${JSON.stringify(TASKNEST_SRC)};\nexport default tool({ marks: ["mystery"], description: "Has unknown mark." }, () => {});\n`,
    },
    async (workspace) => {
      const reg = await discoverTasks(workspace);
      expect(() => validateRegistry(reg)).toThrow(ValidationError);
    },
  );

  await withIsolatedWorkspace(
    {
      "tasknest.toml": [
        "[tasknest]",
        "config_version = 1",
        "[checks]",
        "require_description = true",
      ].join("\n"),
      "tools/nodesc.ts": `import { tool } from ${JSON.stringify(TASKNEST_SRC)};\nexport default tool(() => {});\n`,
    },
    async (workspace) => {
      const reg = await discoverTasks(workspace);
      expect(() => validateRegistry(reg)).toThrow("missing a required description");
    },
  );
});

test("optional test and feature presence checks validate existence", async () => {
  await withIsolatedWorkspace(
    {
      "tasknest.toml": [
        "[tasknest]",
        "config_version = 1",
        "[checks]",
        "require_tests = true",
        "require_features = true",
      ].join("\n"),
      "tools/lint.ts": `import { tool } from ${JSON.stringify(TASKNEST_SRC)};\nexport default tool({ description: "Lint." }, () => {});\n`,
      "tools/tests/lint.test.ts": "// test stub\n",
      "tools/features/lint.feature": "Feature: lint\n",
    },
    async (workspace) => {
      const reg = await discoverTasks(workspace);
      expect(validateRegistry(reg).warnings).toEqual([]);
    },
  );
});

test("mark filtering includes prerequisites and surfaces effects", async () => {
  await withIsolatedWorkspace(
    {
      "tasknest.toml": [
        "[tasknest]",
        "config_version = 1",
        "[checks]",
        "unknown_marks = 'warn'",
        "[marks]",
        "fast = 'Fast'",
        "writes = 'Writes'",
      ].join("\n"),
      "tools/prep.ts": `import { tool } from ${JSON.stringify(TASKNEST_SRC)};\nexport default tool({ description: "Prep." }, () => { console.log("PREP_OK"); });\n`,
      "tools/fmt.ts": `import { tool } from ${JSON.stringify(TASKNEST_SRC)};\nexport default tool({ depends: ["prep"], marks: ["fast", "writes", "custom"], description: "Format." }, () => { console.log("FMT_OK"); });\n`,
    },
    async (workspace) => {
      const reg = await discoverTasks(workspace);
      expect(validateRegistry(reg).warnings.length).toBe(1);
      const order = selectTasksByMarks(reg, ["fast"]);
      expect(order).toEqual(["prep", "fmt"]);
      expect(formatEffectSummary(reg, order)).toEqual(["fmt: marks=fast,writes,custom"]);

      const runner = new CliRunner(workspace);
      const checkRes = await runner.invoke(["check"]);
      expect(checkRes.exitCode).toBe(0);
      expect(checkRes.stderr).toContain("custom");

      const runRes = await runner.invoke(["run", "--mark", "fast"]);
      expect(runRes.exitCode).toBe(0);
      expect(runRes.stdout).toContain("effect: fmt: marks=fast,writes,custom");
      expect(runRes.stdout).toContain("PREP_OK");
      expect(runRes.stdout).toContain("FMT_OK");
    },
  );
});
