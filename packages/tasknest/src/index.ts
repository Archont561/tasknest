/** Tasknest native TypeScript task runner. */

export {
  createRuntimeAdapter,
  isBunRuntime,
  type RuntimeAdapter,
  type RuntimeName,
  type RuntimeSpawnResult,
  type SpawnOptions,
} from "@/src/adapter";
export { createBunAdapter } from "@/src/bun-adapter";
export { type RunCliOptions, runCli } from "@/src/cli";
export {
  DEFAULT_CONFIG_NAME,
  type DiscoveryRoot,
  type LoadConfigOptions,
  loadConfig,
  type TasknestConfig,
} from "@/src/config";
export {
  CommandResult,
  type RunOptions,
  ToolContext,
  type ToolContextOptions,
} from "@/src/context";
export {
  createTaskRegistry,
  type DiscoveredTask,
  type DiscoverOptions,
  discoverTasks,
  type TaskRegistry,
} from "@/src/discovery";
export {
  ConfigError,
  DependencyError,
  DiscoveryError,
  NotImplementedError,
  TasknestError,
  ToolError,
  ValidationError,
} from "@/src/errors";
export {
  type ExecutePlanOptions,
  type ExecutionReport,
  executePlan,
  resolvePlan,
  validateGraph,
} from "@/src/graph";
export { createNodeAdapter } from "@/src/node-adapter";
export {
  coerceOptionValue,
  isTaskDefinition,
  type OptionType,
  type ParsedTaskArgs,
  parseTaskCliArgs,
  type TaskDefinition,
  type TaskHandler,
  type TaskOption,
  type TaskOptionInput,
  type ToolConfig,
  tool,
} from "@/src/task";
export { VERSION, version } from "@/src/version";
