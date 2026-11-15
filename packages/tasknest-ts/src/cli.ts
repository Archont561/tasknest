import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createRuntimeAdapter, type RuntimeAdapter } from "@/src/adapter";
import { AffectedContext, collectGitChanges, normalizeRelPath } from "@/src/affected";
import type { CacheMode } from "@/src/cache";
import { type DiscoveredTask, discoverTasks, type TaskRegistry } from "@/src/discovery";
import { TasknestError, ValidationError } from "@/src/errors";
import {
  computeWorkerBudget,
  type ExecutionReport,
  executeOrder,
  executePlan,
  resolvePlan,
  validateGraph,
} from "@/src/graph";
import { type ReportMetadata, serializeJsonReport, writeJsonReport } from "@/src/report";
import { checkSkill, writeSkill } from "@/src/skill";
import { parseTaskCliArgs } from "@/src/task";
import { formatEffectSummary, selectTasksByMarks, validateRegistry } from "@/src/validation";
import { VERSION } from "@/src/version";
import { type WatchCycle, WatchSession } from "@/src/watch";

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
  "  watch <task...>   Watch declared inputs and re-run dirty subgraph",
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

interface RunCliFlags {
  readonly marks: string[];
  jobs: number | undefined;
  cacheMode: CacheMode;
  jsonOutput: boolean;
  reportPath: string | undefined;
  changedBase: string | undefined;
  readonly changedPaths: string[];
  forceAll: boolean;
  failFast: boolean;
}

interface WatchCliFlags {
  intervalMs: number;
  maxCycles: number | undefined;
  jobs: number | undefined;
  jsonOutput: boolean;
}

function readFlagValue(
  argv: readonly string[],
  idx: number,
  flag: string,
): readonly [string, number] {
  const tok = argv[idx] as string;
  const eqIdx = tok.indexOf("=");
  if (eqIdx !== -1) {
    return [tok.slice(eqIdx + 1), idx + 1];
  }
  if (idx + 1 >= argv.length) {
    throw new ValidationError(`${flag} requires a value.`);
  }
  return [argv[idx + 1] as string, idx + 2];
}

function parsePositiveInt(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new ValidationError(`Option ${flag} requires a positive integer, got '${raw}'.`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError(`Option ${flag} must be >= 1.`);
  }
  return value;
}

function matchesFlag(token: string, flag: string): boolean {
  return token === flag || token.startsWith(`${flag}=`);
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
    } else if (token === "--verbose" || token === "-v") {
      verbose = true;
      idx += 1;
    } else if (matchesFlag(token, "--root")) {
      [root, idx] = readFlagValue(argv, idx, "--root");
    } else if (matchesFlag(token, "--config")) {
      [configPath, idx] = readFlagValue(argv, idx, "--config");
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
  if (task.definition.inputs.length > 0) {
    lines.push(`Inputs: ${task.definition.inputs.join(", ")}`);
  }
  if (task.definition.outputs.length > 0) {
    lines.push(`Outputs: ${task.definition.outputs.join(", ")}`);
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
    if (matchesFlag(token, "--mark")) {
      const [val, nextIdx] = readFlagValue(tokens, idx, "--mark");
      marks.push(val);
      idx = nextIdx;
    } else {
      break;
    }
  }
  return { marks, remaining: tokens.slice(idx) };
}

function parseRunFlags(tokens: readonly string[]): {
  readonly flags: RunCliFlags;
  readonly remaining: readonly string[];
} {
  const flags: RunCliFlags = {
    marks: [],
    jobs: undefined,
    cacheMode: "default",
    jsonOutput: false,
    reportPath: undefined,
    changedBase: undefined,
    changedPaths: [],
    forceAll: false,
    failFast: false,
  };
  let idx = 0;
  while (idx < tokens.length) {
    const token = tokens[idx] as string;
    if (!token.startsWith("-")) {
      break;
    }
    if (matchesFlag(token, "--mark")) {
      const [val, nextIdx] = readFlagValue(tokens, idx, "--mark");
      flags.marks.push(val);
      idx = nextIdx;
    } else if (token === "-j" || matchesFlag(token, "--jobs")) {
      const [val, nextIdx] = readFlagValue(tokens, idx, "--jobs");
      flags.jobs = parsePositiveInt(val, "--jobs");
      idx = nextIdx;
    } else if (matchesFlag(token, "--report")) {
      const [val, nextIdx] = readFlagValue(tokens, idx, "--report");
      flags.reportPath = val;
      idx = nextIdx;
    } else if (matchesFlag(token, "--changed-base")) {
      const [val, nextIdx] = readFlagValue(tokens, idx, "--changed-base");
      flags.changedBase = val;
      idx = nextIdx;
    } else if (matchesFlag(token, "--changed")) {
      const [val, nextIdx] = readFlagValue(tokens, idx, "--changed");
      flags.changedPaths.push(val);
      idx = nextIdx;
    } else if (token === "--force") {
      flags.cacheMode = "force";
      flags.forceAll = true;
      idx += 1;
    } else if (token === "--no-cache") {
      flags.cacheMode = "no_cache";
      idx += 1;
    } else if (token === "--json") {
      flags.jsonOutput = true;
      idx += 1;
    } else if (token === "--all") {
      flags.forceAll = true;
      idx += 1;
    } else if (token === "--fail-fast") {
      flags.failFast = true;
      idx += 1;
    } else {
      throw new ValidationError(`Unknown option for run: ${token}`);
    }
  }
  return { flags, remaining: tokens.slice(idx) };
}

function parseWatchFlags(tokens: readonly string[]): {
  readonly flags: WatchCliFlags;
  readonly remaining: readonly string[];
} {
  const flags: WatchCliFlags = {
    intervalMs: 250,
    maxCycles: undefined,
    jobs: undefined,
    jsonOutput: false,
  };
  let idx = 0;
  while (idx < tokens.length) {
    const token = tokens[idx] as string;
    if (!token.startsWith("-")) {
      break;
    }
    if (matchesFlag(token, "--interval")) {
      const [val, nextIdx] = readFlagValue(tokens, idx, "--interval");
      flags.intervalMs = parsePositiveInt(val, "--interval");
      idx = nextIdx;
    } else if (matchesFlag(token, "--max-cycles")) {
      const [val, nextIdx] = readFlagValue(tokens, idx, "--max-cycles");
      flags.maxCycles = parsePositiveInt(val, "--max-cycles");
      idx = nextIdx;
    } else if (token === "-j" || matchesFlag(token, "--jobs")) {
      const [val, nextIdx] = readFlagValue(tokens, idx, "--jobs");
      flags.jobs = parsePositiveInt(val, "--jobs");
      idx = nextIdx;
    } else if (token === "--json") {
      flags.jsonOutput = true;
      idx += 1;
    } else {
      throw new ValidationError(`Unknown option for watch: ${token}`);
    }
  }
  return { flags, remaining: tokens.slice(idx) };
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

function resolveAffectedContext(
  registry: TaskRegistry,
  flags: RunCliFlags,
  adapter: RuntimeAdapter,
): AffectedContext {
  if (flags.changedPaths.length > 0) {
    return new AffectedContext({
      available: true,
      complete: true,
      files: flags.changedPaths.map((p) => ({
        path: normalizeRelPath(p),
        status: "modified" as const,
      })),
      ...(flags.changedBase !== undefined ? { baseRef: flags.changedBase } : {}),
      targetRef: "CLI",
    });
  }
  if (flags.changedBase !== undefined) {
    return collectGitChanges(registry.config.repoRoot, {
      baseRef: flags.changedBase,
      adapter,
    });
  }
  return new AffectedContext();
}

async function runWithQuietStdout<T>(
  quiet: boolean,
  stderr: (line: string) => void,
  fn: () => Promise<T>,
): Promise<T> {
  if (!quiet) {
    return fn();
  }
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    stderr(args.map((a) => String(a)).join(" "));
  };
  try {
    return await fn();
  } finally {
    console.log = origLog;
  }
}

function emitRunOutputs(
  report: ExecutionReport,
  flags: RunCliFlags,
  target: string | undefined,
  affected: AffectedContext,
  startedAt: string,
  durationMs: number,
  effectiveJobs: number,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): number {
  const meta: ReportMetadata = {
    ...(target !== undefined ? { target } : {}),
    jobs: effectiveJobs,
    startedAt,
    durationMs,
    exitCode: report.exitCode,
    ...(affected.available ? { affected } : {}),
  };
  if (flags.reportPath !== undefined) {
    writeJsonReport(resolve(flags.reportPath), report.records, meta);
  }
  if (flags.jsonOutput) {
    stdout(serializeJsonReport(report.records, meta));
    return report.exitCode;
  }
  if (report.exitCode !== 0) {
    stderr(`Task '${report.failedTask}' failed: ${report.failureMessage ?? "unknown error"}`);
    if (report.blocked.length > 0) {
      stderr(`Blocked tasks: ${report.blocked.join(", ")}`);
    }
  }
  return report.exitCode;
}

async function cmdRun(
  registry: TaskRegistry,
  rest: readonly string[],
  globalArgs: GlobalArgs,
  adapter: RuntimeAdapter,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): Promise<number> {
  const { flags, remaining } = parseRunFlags(rest);
  const affected = resolveAffectedContext(registry, flags, adapter);
  const effectiveJobs = computeWorkerBudget(flags.jobs ?? 1);
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();

  if (flags.marks.length > 0) {
    if (remaining.length > 0) {
      throw new ValidationError("run --mark cannot be combined with a task path.");
    }
    const order = selectTasksByMarks(registry, flags.marks);
    if (!flags.jsonOutput) {
      for (const effect of formatEffectSummary(registry, order)) {
        stdout(`effect: ${effect}`);
      }
    }
    const report = await runWithQuietStdout(flags.jsonOutput, stderr, () =>
      executeOrder(registry, order, {
        verbose: globalArgs.verbose,
        adapter,
        jobs: effectiveJobs,
        failFast: flags.failFast,
        cacheMode: flags.cacheMode,
        affected,
        quietStdout: flags.jsonOutput,
        stderrWriter: (chunk) => stderr(chunk.replace(/\r?\n$/, "")),
      }),
    );
    return emitRunOutputs(
      report,
      flags,
      undefined,
      affected,
      startedAt,
      performance.now() - startedMs,
      effectiveJobs,
      stdout,
      stderr,
    );
  }

  const [task, tail] = resolveTaskTokens(registry, remaining);
  const parsed = parseTaskCliArgs(task.definition, tail);
  const report = await runWithQuietStdout(flags.jsonOutput, stderr, () =>
    executePlan(registry, task.canonicalName, {
      targetValues: parsed.values,
      targetPositionals: parsed.positionals,
      verbose: globalArgs.verbose,
      adapter,
      jobs: effectiveJobs,
      failFast: flags.failFast,
      cacheMode: flags.cacheMode,
      affected,
      quietStdout: flags.jsonOutput,
      stderrWriter: (chunk) => stderr(chunk.replace(/\r?\n$/, "")),
    }),
  );
  return emitRunOutputs(
    report,
    flags,
    task.canonicalName,
    affected,
    startedAt,
    performance.now() - startedMs,
    effectiveJobs,
    stdout,
    stderr,
  );
}

function formatWatchCycle(
  cycleIndex: number,
  cycle: WatchCycle,
  asJson: boolean,
  stdout: (line: string) => void,
): void {
  if (asJson) {
    stdout(
      JSON.stringify({
        cycle: cycleIndex,
        changed_files: cycle.changedFiles,
        executed: cycle.executed,
        skipped_clean: cycle.skippedClean,
        exit_code: cycle.report.exitCode,
      }),
    );
    return;
  }
  const changed = cycle.changedFiles.join(", ") || "initial";
  const ran = cycle.executed.join(", ") || "none";
  const clean = cycle.skippedClean.join(", ") || "none";
  stdout(`[watch #${cycleIndex}] changed=${changed} ran=${ran} clean=${clean}`);
}

async function cmdWatch(
  registry: TaskRegistry,
  rest: readonly string[],
  globalArgs: GlobalArgs,
  adapter: RuntimeAdapter,
  stdout: (line: string) => void,
): Promise<number> {
  const { flags, remaining } = parseWatchFlags(rest);
  const [task] = resolveTaskTokens(registry, remaining);
  const session = new WatchSession(
    registry,
    task.canonicalName,
    {
      pollIntervalMs: flags.intervalMs,
      jobs: flags.jobs ?? 1,
      verbose: globalArgs.verbose,
    },
    adapter,
  );
  let cycleNum = 0;
  const cycles = await session.watch({
    ...(flags.maxCycles !== undefined ? { maxCycles: flags.maxCycles } : {}),
    onCycle: (cycle) => {
      cycleNum += 1;
      formatWatchCycle(cycleNum, cycle, flags.jsonOutput, stdout);
    },
  });
  const last = cycles.at(-1);
  return last ? last.report.exitCode : 0;
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
    } else if (matchesFlag(token, "--output")) {
      [outputPath, idx] = readFlagValue(rest, idx, "--output");
    } else if (matchesFlag(token, "--template")) {
      [templatePath, idx] = readFlagValue(rest, idx, "--template");
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
    case "watch":
      return cmdWatch(registry, rest, globalArgs, adapter, stdout);
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
