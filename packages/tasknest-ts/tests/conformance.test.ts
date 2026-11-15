import { existsSync, readFileSync, rmSync } from "node:fs";
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

interface ScenarioWriteFile {
  readonly path: string;
  readonly content: string;
}

interface ScenarioTask {
  readonly path: string;
  readonly name: string;
  readonly description?: string;
  readonly depends?: readonly string[];
  readonly marks?: readonly string[];
  readonly requires?: readonly string[];
  readonly inputs?: readonly string[];
  readonly outputs?: readonly string[];
  readonly cache?: boolean;
  readonly options?: readonly ScenarioOption[];
  readonly prints?: readonly string[];
  readonly failMessage?: string;
  readonly outputValue?: unknown;
  readonly readDep?: string;
  readonly writeFile?: ScenarioWriteFile;
}

interface ExpectedJson {
  readonly schema_version?: number;
  readonly status?: string;
  readonly taskCacheStatus?: Readonly<Record<string, string>>;
  readonly taskStatus?: Readonly<Record<string, string>>;
}

interface ScenarioInvocation {
  readonly args: readonly string[];
  readonly deleteFile?: string;
  readonly expectExitCode: number;
  readonly expectStdoutContains?: readonly string[];
  readonly expectStdoutNotContains?: readonly string[];
  readonly expectStderrContains?: readonly string[];
  readonly expectJson?: ExpectedJson;
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
    inputs: task.inputs ?? [],
    outputs: task.outputs ?? [],
    cache: task.cache ?? false,
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
    if (task.writeFile) {
      bodyLines.push(
        `  const outFile = join(ctx.projectRoot, ${JSON.stringify(task.writeFile.path)});`,
      );
      bodyLines.push("  mkdirSync(dirname(outFile), { recursive: true });");
      bodyLines.push(
        `  writeFileSync(outFile, ${JSON.stringify(task.writeFile.content)}, "utf-8");`,
      );
    }
    if (task.outputValue !== undefined) {
      bodyLines.push(`  ctx.output(${JSON.stringify(task.outputValue)});`);
    }
    if (task.readDep !== undefined) {
      bodyLines.push(
        `  const depVal = ctx.deps[${JSON.stringify(task.readDep)}] as { greeting: string; count: number };`,
      );
      bodyLines.push(
        `  console.log(\`DEP:${task.readDep}:\${depVal.greeting}:\${depVal.count}\`);`,
      );
    }
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
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    `import { ToolError, tool } from ${JSON.stringify(TASKNEST_SRC)};`,
    `export default tool(${JSON.stringify(toolConfig)}, (ctx, args, pos) => {`,
    ...bodyLines,
    "});",
  ].join("\n");
}

function assertExpectedJson(stdout: string, expected: ExpectedJson): void {
  const payload = JSON.parse(stdout) as {
    schema_version: number;
    status: string;
    tasks: { name: string; status: string; cache_status: string }[];
  };
  if (expected.schema_version !== undefined) {
    expect(payload.schema_version).toBe(expected.schema_version);
  }
  if (expected.status !== undefined) {
    expect(payload.status).toBe(expected.status);
  }
  const byName = new Map(payload.tasks.map((t) => [t.name, t]));
  for (const [name, cacheStatus] of Object.entries(expected.taskCacheStatus ?? {})) {
    expect(byName.get(name)?.cache_status).toBe(cacheStatus);
  }
  for (const [name, status] of Object.entries(expected.taskStatus ?? {})) {
    expect(byName.get(name)?.status).toBe(status);
  }
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
        if (inv.deleteFile !== undefined) {
          const target = join(workspace, inv.deleteFile);
          if (existsSync(target)) {
            rmSync(target);
          }
        }
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
        if (inv.expectJson !== undefined) {
          assertExpectedJson(res.stdout, inv.expectJson);
        }
      }
    });
  });
}
