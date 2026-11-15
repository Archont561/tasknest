import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { discoverTasks } from "@/src/discovery";
import { ToolError } from "@/src/errors";
import { checkSkill, renderSkill, writeSkill } from "@/src/skill";
import { CliRunner, withIsolatedWorkspace } from "@/src/testing";
import { expect, test } from "@/tests/test";

const TASKNEST_SRC = join(import.meta.dir, "..", "src", "index.ts");

test("skill generation is deterministic, checks drift, and guards manual files", async () => {
  await withIsolatedWorkspace(
    {
      "tasknest.toml": [
        "[tasknest]",
        "config_version = 1",
        "[skill]",
        "output = '.agents/SKILL.md'",
        "command = 'pixi run tools'",
      ].join("\n"),
      "tools/z_last.ts": `import { tool } from ${JSON.stringify(TASKNEST_SRC)};\nexport default tool({ marks: ["fast"], description: "Last task." }, () => {});\n`,
      "tools/a_first.ts": `import { tool } from ${JSON.stringify(TASKNEST_SRC)};\nexport default tool({ depends: ["z_last"], requires: ["ruff"], description: "First task." }, () => {});\n`,
    },
    async (workspace) => {
      const registry = await discoverTasks(workspace);
      const r1 = await renderSkill(registry);
      const r2 = await renderSkill(registry);
      expect(r1).toBe(r2);
      expect(r1).toContain("pixi run tools run a_first");
      expect(r1).toContain("First task.");
      expect(r1.indexOf("a_first")).toBeLessThan(r1.indexOf("z_last"));

      expect(await checkSkill(registry)).toBe(false);
      const target = join(workspace, ".agents/SKILL.md");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "# Custom manual skill\n", "utf-8");

      expect(await checkSkill(registry)).toBe(false);
      expect(readFileSync(target, "utf-8")).toBe("# Custom manual skill\n");

      await expect(writeSkill(registry)).rejects.toThrow(ToolError);
      expect(readFileSync(target, "utf-8")).toBe("# Custom manual skill\n");

      await writeSkill(registry, { force: true });
      expect(await checkSkill(registry)).toBe(true);

      const cliRes = await new CliRunner(workspace).invoke(["skill", "--check"]);
      expect(cliRes.exitCode).toBe(0);
    },
  );
});
