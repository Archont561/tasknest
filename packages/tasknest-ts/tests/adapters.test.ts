import { join } from "node:path";
import {
  BunAdapter,
  PytestAdapter,
  RuffAdapter,
  requireExecutable,
  selectAffectedTargets,
} from "@/src/adapters";
import { ToolContext } from "@/src/context";
import { ToolError } from "@/src/errors";
import { withIsolatedWorkspace } from "@/src/testing";
import { expect, test } from "@/tests/test";

test("requireExecutable diagnoses missing tool without installing", () => {
  expect(() => requireExecutable("definitely-missing-tasknest-tool-xyz")).toThrow(ToolError);
});

test("selectAffectedTargets falls back conservatively on unknown or global changes", () => {
  const mapping = {
    "src/app.ts": ["tests/app.test.ts"],
    "src/cli.ts": ["tests/cli.test.ts", "tests/app.test.ts"],
  };

  const targeted = selectAffectedTargets(["src/cli.ts"], mapping);
  expect(targeted.targets).toEqual(["tests/cli.test.ts", "tests/app.test.ts"]);
  expect(targeted.fallbackReason).toBeUndefined();

  const unmapped = selectAffectedTargets(["src/other.ts"], mapping);
  expect(unmapped.targets).toEqual(["tests"]);
  expect(unmapped.fallbackReason).toContain("unmapped");

  const globalTrigger = selectAffectedTargets(["src/app.ts", "package.json"], mapping);
  expect(globalTrigger.targets).toEqual(["tests"]);
  expect(globalTrigger.fallbackReason).toContain("global trigger");

  const noMap = selectAffectedTargets(["src/app.ts"], undefined);
  expect(noMap.targets).toEqual(["tests"]);
  expect(noMap.fallbackReason).toBeDefined();
});

test("BunAdapter escape hatch and adapter properties work via ToolContext", async () => {
  await withIsolatedWorkspace(
    {
      "tests/smoke.test.ts": [
        `import { expect, test } from ${JSON.stringify(join(import.meta.dir, "test.ts"))};`,
        `test("ok", () => { expect(1).toBe(1); });`,
      ].join("\n"),
    },
    (workspace) => {
      const ctx = new ToolContext({
        repoRoot: workspace,
        projectRoot: workspace,
        taskName: "adapt",
      });
      const bun = new BunAdapter(ctx);
      const res = bun.exec(["bun", "-e", "console.log('ESCAPE_HATCH')"], { capture: true });
      expect(res.stdout).toContain("ESCAPE_HATCH");
      expect(new RuffAdapter(ctx).executable).toBe("ruff");
      expect(new PytestAdapter(ctx).executable).toBe("pytest");
    },
  );
});
