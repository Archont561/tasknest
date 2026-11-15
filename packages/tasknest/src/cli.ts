import { resolve } from "node:path";
import { createRuntimeAdapter, type RuntimeAdapter } from "@/src/adapter";
import { type DiscoveredTask, discoverTasks, type TaskRegistry } from "@/src/discovery";
import { TasknestError, ValidationError } from "@/src/errors";
import { executePlan, resolvePlan, validateGraph } from "@/src/graph";
import { parseTaskCliArgs } from "@/src/task";

export const version = "0.1.0-dev.0";

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
  "  check             Validate discovery and dependency graph",
  "  plan <task...>    Show execution order without running tasks",
  "  run <task...>     Execute a task and its prerequisites",
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
      if (idx + 1 >= argv.length) {
        throw new ValidationError("--root requires a path.");
      }
      root = argv[idx + 1] as string;
      idx += 2;
    } else if (token.startsWith("--root=")) {
      root = token.slice("--root=".length);
      idx += 1;
    } else if (token === "--config") {
      if (idx + 1 >= argv.length) {
        throw new ValidationError("--config requires a path.");
      }
      configPath = argv[idx + 1] as string;
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
    case "ls": {
      const tasks = Object.values(registry.tasks);
      if (tasks.length === 0) {
        stdout("No tasks discovered.");
        return 0;
      }
      for (const task of tasks) {
        const summary = task.description ? ` - ${task.description}` : "";
        stdout(`${task.cliPath.join(" ")} (${task.canonicalName})${summary}`);
      }
      return 0;
    }
    case "help": {
      if (rest.length === 0) {
        stdout(GLOBAL_HELP);
        return 0;
      }
      const [task] = resolveTaskTokens(registry, rest);
      stdout(formatTaskHelp(task));
      return 0;
    }
    case "check": {
      validateGraph(registry);
      stdout(`Checked ${Object.keys(registry.tasks).length} task(s).`);
      return 0;
    }
    case "plan": {
      const [task] = resolveTaskTokens(registry, rest);
      const order = resolvePlan(registry, task.canonicalName);
      for (const name of order) {
        stdout(name);
      }
      return 0;
    }
    case "run": {
      const [task, tail] = resolveTaskTokens(registry, rest);
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
      stdout(`tasknest ${version}`);
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
