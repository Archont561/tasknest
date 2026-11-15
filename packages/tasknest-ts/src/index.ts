/** Tasknest native TypeScript task runner. */

export {
  createLineDispatcher,
  createRuntimeAdapter,
  isBunRuntime,
  type RuntimeAdapter,
  type RuntimeName,
  type RuntimeSpawnResult,
  type SpawnOptions,
  type WatchHandle,
} from "@/src/adapter";
export {
  type AffectedTestPlan,
  BunAdapter,
  findExecutable,
  NodeAdapter,
  PytestAdapter,
  RuffAdapter,
  requireExecutable,
  selectAffectedTargets,
  ToolAdapter,
} from "@/src/adapters";
export {
  AffectedContext,
  type AffectedContextData,
  buildTsReverseMap,
  type ChangedFile,
  type ChangeStatus,
  collectGitChanges,
  DEFAULT_ALWAYS_FULL,
  normalizeRelPath,
  parseGitNameStatus,
  type SelectionPolicy,
  selectConservativeTargets,
} from "@/src/affected";
export { createBunAdapter } from "@/src/bun-adapter";
export {
  type CacheContext,
  type CacheLookup,
  type CacheMode,
  type CacheStatus,
  computeFullKey,
  computeStaticKey,
  expandInputHashes,
  lookupCache,
  storeCache,
} from "@/src/cache";
export { type RunCliOptions, runCli } from "@/src/cli";
export {
  type ChecksConfig,
  DEFAULT_CONFIG_NAME,
  type DiscoveryRoot,
  type LoadConfigOptions,
  loadConfig,
  type ManifestRoot,
  type SkillConfig,
  type TasknestConfig,
  type UnknownMarkMode,
} from "@/src/config";
export {
  type BufferedOutput,
  CommandResult,
  canonicalJsonString,
  OUTPUT_FORMAT_JSON,
  type OutputOptions,
  type RecordedCommand,
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
  computeWorkerBudget,
  type ExecutePlanOptions,
  type ExecutionReport,
  executeOrder,
  executePlan,
  resolvePlan,
  validateGraph,
} from "@/src/graph";
export { discoverManifestTasks } from "@/src/manifests";
export { createNodeAdapter } from "@/src/node-adapter";
export {
  buildJsonReport,
  REDACTED_PLACEHOLDER,
  REPORT_SCHEMA_VERSION,
  type ReportMetadata,
  redactArgv,
  redactText,
  serializeJsonReport,
  serializeTaskRecord,
  type TaskRunRecord,
  type TaskStatus,
  writeJsonReport,
} from "@/src/report";
export {
  checkSkill,
  DEFAULT_SKILL_TEMPLATE,
  GENERATED_MARKER,
  renderSkill,
  resolveSkillOutput,
  writeSkill,
} from "@/src/skill";
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
export {
  type CliInvokeOptions,
  type CliResult,
  CliRunner,
  withIsolatedWorkspace,
} from "@/src/testing";
export {
  formatEffectSummary,
  matchesPackage,
  selectTasksByMarks,
  selectTasksEach,
  type ValidationResult,
  validateRegistry,
} from "@/src/validation";
export { VERSION, version } from "@/src/version";
export { type WatchConfig, type WatchCycle, WatchSession } from "@/src/watch";
