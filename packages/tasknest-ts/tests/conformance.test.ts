import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CliRunner, withIsolatedWorkspace } from "@/src/testing";
import { expect, test } from "@/tests/test";

const TASKNEST_SRC = join(import.meta.dir, "..", "src", "index.ts");
const SCENARIOS_PATH = join(import.meta.dir, "..", "..", "..", "conformance", "scenarios.json");

interface ScenarioOption {
  readonly name: string;
  readonly type?: "string" | "int" | "float" | "boolean" | "path";
  readonly choices?: readonly (string | number)[];
  readonly default?: unknown;
}

interface ScenarioTask {
  readonly path: string;
  readonly name: string;
  readonly description?: string;
  readonly depends?: readonly string[];
  readonly marks?: readonly string[];
  readonly requires?: readonly string[];
  readonly options?: readonly ScenarioOption[];
  readonly prints?: readonly string[];
  readonly failMessage?: string;
}

interface ScenarioInvocation {
  readonly args: readonly string[];
  readonly expectExitCode: number;
  readonly expectStdoutContains?: readonly string[];
  readonly expectStdoutNotContains?: readonly string[];
  readonly expectStderrContains?: readonly string[];
}

interface Scenario {
  readonly id: string;
  readonly config?: string;
  readonly tasks?: readonly ScenarioTask[];
  readonly extraFiles?: Readonly<Record<string, string>>;
  readonly invocations: readonly ScenarioInvocation[];
}

function renderTsTask(task: ScenarioTask): string {
  const toolConfig = {
    name: task.name,
    description: task.description ?? "",
    depends: task.depends ?? [],
    marks: task.marks ?? [],
    requires: task.requires ?? [],
    options: (task.options ?? []).map((opt) => ({
      name: opt.name,
      type: opt.type ?? "string",
      ...(opt.choices !== undefined ? { choices: opt.choices } : {}),
      ...(opt.default !== undefined ? { default: opt.default } : {}),
    })),
  };

  const bodyLines: string[] = [];
  if (task.failMessage) {
    bodyLines.push(`  throw new ToolError(${JSON.stringify(task.failMessage)});`);
  } else {
    for (const rawMsg of task.prints ?? []) {
      const expr = rawMsg.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
        if (key === "arg") {
          return `\${String(pos[0] ?? args.arg ?? "")}`;
        }
        return `\${String(args.${key})}`;
      });
      bodyLines.push(`  console.log(\`${expr}\`);`);
    }
  }

  return [
    `import { ToolError, tool } from ${JSON.stringify(TASKNEST_SRC)};`,
    `export default tool(${JSON.stringify(toolConfig)}, (_ctx, args, pos) => {`,
    ...bodyLines,
    "});",
  ].join("\n");
}

const payload = JSON.parse(readFileSync(SCENARIOS_PATH, "utf-8")) as {
  readonly scenarios: readonly Scenario[];
};

for (const scenario of payload.scenarios) {
  test(`conformance: ${scenario.id}`, async () => {
    const files: Record<string, string> = {};
    if (scenario.config !== undefined) {
      files["tasknest.toml"] = scenario.config;
    }
    for (const [rel, content] of Object.entries(scenario.extraFiles ?? {})) {
      const needsExt = rel.startsWith("tools/") && !basename(rel).includes(".");
      files[needsExt ? `${rel}.ts` : rel] = content;
    }
    for (const task of scenario.tasks ?? []) {
      files[`tools/${task.path}.ts`] = renderTsTask(task);
    }

    await withIsolatedWorkspace(files, async (workspace) => {
      const runner = new CliRunner(workspace);
      for (const inv of scenario.invocations) {
        const res = await runner.invoke(inv.args);
        expect(res.exitCode).toBe(inv.expectExitCode);
        for (const text of inv.expectStdoutContains ?? []) {
          expect(res.stdout).toContain(text);
        }
        for (const text of inv.expectStdoutNotContains ?? []) {
          expect(res.stdout).not.toContain(text);
        }
        for (const text of inv.expectStderrContains ?? []) {
          expect(res.stderr).toContain(text);
        }
      }
    });
  });
}
