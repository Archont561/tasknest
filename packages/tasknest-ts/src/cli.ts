import { resolve } from "node:path";
import { createRuntimeAdapter, type RuntimeAdapter } from "@/src/adapter";
import { type DiscoveredTask, discoverTasks, type TaskRegistry } from "@/src/discovery";
import { TasknestError, ValidationError } from "@/src/errors";
import { executeOrder, executePlan, resolvePlan, validateGraph } from "@/src/graph";
import { checkSkill, writeSkill } from "@/src/skill";
import { parseTaskCliArgs } from "@/src/task";
import { formatEffectSummary, selectTasksByMarks, validateRegistry } from "@/src/validation";
import { VERSION } from "@/src/version";

const GLOBAL_HELP = [
  "Usage: tasknest [GLOBAL OPTIONS] <command> [ARGS...]",
  "",
  "Global options (before command):",
  "  --root <path>     Repository root directory",
  "  --config <path>   Path to tasknest.toml",
  "  --verbose         Enable verbose context output",
  "  --help, -h        Show help message",
  "  --version, -V     Show version",
  "",
  "Commands:",
  "  ls                List discovered tasks",
  "  help [task...]    Show global or task help",
  "  check             Validate discovery, marks, and dependency graph",
  "  plan <task...>    Show execution order without running tasks",
  "  run <task...>     Execute a task and its prerequisites",
  "  skill             Check or write generated agent SKILL.md",
].join("\n");

export interface RunCliOptions {
  readonly cwd?: string;
  readonly adapter?: RuntimeAdapter;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

interface GlobalArgs {
  readonly root: string;
  readonly configPath?: string;
  readonly verbose: boolean;
  readonly showHelp: boolean;
  readonly showVersion: boolean;
  readonly rest: string[];
}

function readGlobalValue(argv: readonly string[], idx: number, flag: string): string {
  if (idx + 1 >= argv.length) {
    throw new ValidationError(`${flag} requires a path.`);
  }
  return argv[idx + 1] as string;
}

function parseGlobalArgs(argv: readonly string[], defaultRoot: string): GlobalArgs {
  let root = defaultRoot;
  let configPath: string | undefined;
  let verbose = false;
  let showHelp = false;
  let showVersion = false;
  let idx = 0;

  while (idx < argv.length) {
    const token = argv[idx] as string;
    if (!token.startsWith("-")) {
      break;
    }
    if (token === "--help" || token === "-h") {
      showHelp = true;
      idx += 1;
    } else if (token === "--version" || token === "-V") {
      showVersion = true;
      idx += 1;
    } else if (token === "--verbose") {
      verbose = true;
      idx += 1;
    } else if (token === "--root") {
      root = readGlobalValue(argv, idx, "--root");
      idx += 2;
    } else if (token.startsWith("--root=")) {
      root = token.slice("--root=".length);
      idx += 1;
    } else if (token === "--config") {
      configPath = readGlobalValue(argv, idx, "--config");
      idx += 2;
    } else if (token.startsWith("--config=")) {
      configPath = token.slice("--config=".length);
      idx += 1;
    } else {
      throw new ValidationError(`Unknown global option: ${token}`);
    }
  }

  return {
    root: resolve(root),
    ...(configPath !== undefined ? { configPath } : {}),
    verbose,
    showHelp,
    showVersion,
    rest: argv.slice(idx),
  };
}

function resolveTaskTokens(
  registry: TaskRegistry,
  tokens: readonly string[],
): readonly [DiscoveredTask, readonly string[]] {
  const pathTokens: string[] = [];
  let tailIndex = tokens.length;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token === "--" || token.startsWith("-")) {
      tailIndex = i;
      break;
    }
    pathTokens.push(token);
  }

  if (pathTokens.length === 0) {
    throw new ValidationError("A task path is required.");
  }

  const resolved = registry.resolveCliPath(pathTokens);
  if (!resolved) {
    throw new ValidationError(`Unknown task '${pathTokens.join(" ")}'.`);
  }
  const [task, unusedPathTokens] = resolved;
  let tail = [...unusedPathTokens, ...tokens.slice(tailIndex)];
  if (tail[0] === "--") {
    tail = tail.slice(1);
  }
  return [task, tail];
}

function formatTaskHelp(task: DiscoveredTask): string {
  const lines = [
    `Task: ${task.cliPath.join(" ")} (${task.canonicalName})`,
    `Description: ${task.description || "(none)"}`,
  ];
  if (task.definition.depends.length > 0) {
    const depNames = task.definition.depends.map((d) => (typeof d === "string" ? d : d.name));
    lines.push(`Depends: ${depNames.join(", ")}`);
  }
  if (task.definition.options.length > 0) {
    lines.push("Options:");
    for (const opt of task.definition.options) {
      const desc = opt.description ? ` - ${opt.description}` : "";
      lines.push(`  ${opt.flagName} (${opt.baseType})${desc}`);
    }
  }
  return lines.join("\n");
}

function parseMarkFlags(tokens: readonly string[]): {
  readonly marks: readonly string[];
  readonly remaining: readonly string[];
} {
  const marks: string[] = [];
  let idx = 0;
  while (idx < tokens.length) {
    const token = tokens[idx] as string;
    if (token === "--mark") {
      if (idx + 1 >= tokens.length) {
        throw new ValidationError("--mark requires a value.");
      }
      marks.push(tokens[idx + 1] as string);
      idx += 2;
    } else if (token.startsWith("--mark=")) {
      marks.push(token.slice("--mark=".length));
      idx += 1;
    } else {
      break;
    }
  }
  return { marks, remaining: tokens.slice(idx) };
}

function cmdLs(
  registry: TaskRegistry,
  rest: readonly string[],
  stdout: (line: string) => void,
): number {
  const { marks, remaining } = parseMarkFlags(rest);
  if (remaining.length > 0) {
    throw new ValidationError("ls accepts only --mark <name> options.");
  }
  const tasks = Object.values(registry.tasks)
    .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName))
    .filter(
      (task) => marks.length === 0 || marks.some((mark) => task.definition.marks.includes(mark)),
    );
  if (tasks.length === 0) {
    stdout("No tasks discovered.");
    return 0;
  }
  for (const task of tasks) {
    const markSuffix =
      task.definition.marks.length > 0 ? ` [marks: ${task.definition.marks.join(", ")}]` : "";
    const summary = task.description ? ` - ${task.description}` : "";
    stdout(`${task.cliPath.join(" ")} (${task.canonicalName})${markSuffix}${summary}`);
  }
  return 0;
}

function cmdHelp(
  registry: TaskRegistry,
  rest: readonly string[],
  stdout: (line: string) => void,
): number {
  if (rest.length === 0) {
    stdout(GLOBAL_HELP);
    return 0;
  }
  const [task] = resolveTaskTokens(registry, rest);
  stdout(formatTaskHelp(task));
  return 0;
}

function cmdCheck(
  registry: TaskRegistry,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): number {
  const result = validateRegistry(registry);
  for (const warning of result.warnings) {
    stderr(`warning: ${warning}`);
  }
  validateGraph(registry);
  stdout(`Checked ${Object.keys(registry.tasks).length} task(s).`);
  return 0;
}

function cmdPlan(
  registry: TaskRegistry,
  rest: readonly string[],
  stdout: (line: string) => void,
): number {
  const { marks, remaining } = parseMarkFlags(rest);
  let order: readonly string[];
  if (marks.length > 0) {
    if (remaining.length > 0) {
      throw new ValidationError("plan --mark cannot be combined with a task path.");
    }
    order = selectTasksByMarks(registry, marks);
  } else {
    const [task] = resolveTaskTokens(registry, remaining);
    order = resolvePlan(registry, task.canonicalName);
  }
  for (const name of order) {
    stdout(name);
  }
  for (const effect of formatEffectSummary(registry, order)) {
    stdout(`effect: ${effect}`);
  }
  return 0;
}

async function cmdRun(
  registry: TaskRegistry,
  rest: readonly string[],
  globalArgs: GlobalArgs,
  adapter: RuntimeAdapter,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): Promise<number> {
  const { marks, remaining } = parseMarkFlags(rest);
  if (marks.length > 0) {
    if (remaining.length > 0) {
      throw new ValidationError("run --mark cannot be combined with a task path.");
    }
    const order = selectTasksByMarks(registry, marks);
    for (const effect of formatEffectSummary(registry, order)) {
      stdout(`effect: ${effect}`);
    }
    const report = await executeOrder(registry, order, {
      verbose: globalArgs.verbose,
      adapter,
    });
    if (report.exitCode !== 0) {
      stderr(`Task '${report.failedTask}' failed: ${report.failureMessage ?? "unknown error"}`);
      if (report.blocked.length > 0) {
        stderr(`Blocked tasks: ${report.blocked.join(", ")}`);
      }
    }
    return report.exitCode;
  }
  const [task, tail] = resolveTaskTokens(registry, remaining);
  const parsed = parseTaskCliArgs(task.definition, tail);
  const report = await executePlan(registry, task.canonicalName, {
    targetValues: parsed.values,
    targetPositionals: parsed.positionals,
    verbose: globalArgs.verbose,
    adapter,
  });
  if (report.exitCode !== 0) {
    stderr(`Task '${report.failedTask}' failed: ${report.failureMessage ?? "unknown error"}`);
    if (report.blocked.length > 0) {
      stderr(`Blocked tasks: ${report.blocked.join(", ")}`);
    }
  }
  return report.exitCode;
}

async function cmdSkill(
  registry: TaskRegistry,
  rest: readonly string[],
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): Promise<number> {
  let writeMode = false;
  let force = false;
  let outputPath: string | undefined;
  let templatePath: string | undefined;
  let idx = 0;

  while (idx < rest.length) {
    const token = rest[idx] as string;
    if (token === "--write") {
      writeMode = true;
      idx += 1;
    } else if (token === "--check") {
      writeMode = false;
      idx += 1;
    } else if (token === "--force") {
      force = true;
      idx += 1;
    } else if (token === "--output") {
      outputPath = readGlobalValue(rest, idx, "--output");
      idx += 2;
    } else if (token === "--template") {
      templatePath = readGlobalValue(rest, idx, "--template");
      idx += 2;
    } else {
      throw new ValidationError(`Unknown option for skill: ${token}`);
    }
  }

  if (writeMode) {
    const written = await writeSkill(registry, {
      ...(outputPath !== undefined ? { outputPath } : {}),
      ...(templatePath !== undefined ? { templatePath } : {}),
      force,
    });
    stdout(`WROTE ${written}`);
    return 0;
  }
  const ok = await checkSkill(registry, {
    ...(outputPath !== undefined ? { outputPath } : {}),
    ...(templatePath !== undefined ? { templatePath } : {}),
  });
  if (!ok) {
    stderr("DRIFT skill output is missing or out of date");
    return 1;
  }
  stdout("OK skill is up to date");
  return 0;
}

async function handleCommand(
  command: string,
  rest: readonly string[],
  registry: TaskRegistry,
  globalArgs: GlobalArgs,
  adapter: RuntimeAdapter,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): Promise<number> {
  switch (command) {
    case "ls":
      return cmdLs(registry, rest, stdout);
    case "help":
      return cmdHelp(registry, rest, stdout);
    case "check":
      return cmdCheck(registry, stdout, stderr);
    case "plan":
      return cmdPlan(registry, rest, stdout);
    case "run":
      return cmdRun(registry, rest, globalArgs, adapter, stdout, stderr);
    case "skill":
      return cmdSkill(registry, rest, stdout, stderr);
    default:
      throw new ValidationError(`Unknown command '${command}'.`);
  }
}

export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const adapter = options.adapter ?? createRuntimeAdapter();

  try {
    const globalArgs = parseGlobalArgs(argv, options.cwd ?? process.cwd());
    if (globalArgs.showVersion) {
      stdout(`tasknest ${VERSION}`);
      return 0;
    }
    if (globalArgs.showHelp || globalArgs.rest.length === 0) {
      stdout(GLOBAL_HELP);
      return 0;
    }
    const [command, ...rest] = globalArgs.rest;
    if (command === "help" && rest.length === 0) {
      stdout(GLOBAL_HELP);
      return 0;
    }
    const registry = await discoverTasks(globalArgs.root, {
      ...(globalArgs.configPath !== undefined ? { configPath: globalArgs.configPath } : {}),
      adapter,
    });
    return await handleCommand(
      command as string,
      rest,
      registry,
      globalArgs,
      adapter,
      stdout,
      stderr,
    );
  } catch (err) {
    if (err instanceof TasknestError) {
      stderr(err.message);
      return err.exitCode;
    }
    const message = err instanceof Error ? err.message : String(err);
    stderr(message);
    return 1;
  }
}
