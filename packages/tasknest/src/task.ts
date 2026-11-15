import type { ToolContext } from "@/src/context";
import { ValidationError } from "@/src/errors";

export type OptionType = "string" | "int" | "float" | "boolean" | "path";

const VALID_OPTION_TYPES = new Set<string>(["string", "int", "float", "boolean", "path"]);

export interface TaskOptionInput {
  readonly name: string;
  readonly type?: OptionType;
  readonly choices?: readonly (string | number)[];
  readonly multiple?: boolean;
  readonly optional?: boolean;
  readonly default?: unknown;
  readonly description?: string;
}

export interface TaskOption {
  readonly name: string;
  readonly flagName: string;
  readonly baseType: OptionType;
  readonly multiple: boolean;
  readonly optional: boolean;
  readonly hasDefault: boolean;
  readonly defaultValue: unknown;
  readonly choices: readonly (string | number)[] | undefined;
  readonly description: string;
}

export type TaskHandler = (
  ctx: ToolContext,
  args: Record<string, unknown>,
  positionals: readonly string[],
) => void | Promise<void>;

export interface ToolConfig {
  readonly name?: string;
  readonly depends?: readonly (string | TaskDefinition)[];
  readonly marks?: readonly string[];
  readonly requires?: readonly string[];
  readonly description?: string;
  readonly options?: readonly TaskOptionInput[];
}

export interface TaskDefinition {
  readonly kind: "tasknest.tool";
  readonly name: string;
  readonly depends: readonly (string | TaskDefinition)[];
  readonly marks: readonly string[];
  readonly requires: readonly string[];
  readonly description: string;
  readonly options: readonly TaskOption[];
  readonly handler: TaskHandler;
}

export interface ParsedTaskArgs {
  readonly values: Record<string, unknown>;
  readonly positionals: readonly string[];
}

const activeCollectors: TaskDefinition[][] = [];

export async function collectTaskRegistrations(fn: () => Promise<void>): Promise<TaskDefinition[]> {
  const bucket: TaskDefinition[] = [];
  activeCollectors.push(bucket);
  try {
    await fn();
  } finally {
    activeCollectors.pop();
  }
  return bucket;
}

function normalizeOption(taskName: string, input: TaskOptionInput): TaskOption {
  const baseType = input.type ?? "string";
  if (!VALID_OPTION_TYPES.has(baseType)) {
    throw new ValidationError(
      `Unsupported parameter type '${String(baseType)}' for '${input.name}' in task '${taskName}'.`,
    );
  }
  if (input.choices !== undefined) {
    if (input.choices.length === 0) {
      throw new ValidationError(
        `choices for '${input.name}' in task '${taskName}' cannot be empty.`,
      );
    }
    const invalidChoice = input.choices.some(
      (choice) => typeof choice !== "string" && typeof choice !== "number",
    );
    if (invalidChoice) {
      throw new ValidationError(
        `choices for '${input.name}' in task '${taskName}' must be strings or integers.`,
      );
    }
  }
  const hasDefault = "default" in input && input.default !== undefined;
  return {
    name: input.name,
    flagName: `--${input.name.replaceAll("_", "-")}`,
    baseType,
    multiple: input.multiple ?? false,
    optional: input.optional ?? false,
    hasDefault,
    defaultValue: input.default,
    choices: input.choices ? [...input.choices] : undefined,
    description: input.description ?? "",
  };
}

export function isTaskDefinition(value: unknown): value is TaskDefinition {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "tasknest.tool"
  );
}

export function tool(handler: TaskHandler): TaskDefinition;
export function tool(config: ToolConfig, handler: TaskHandler): TaskDefinition;
export function tool(
  configOrHandler: ToolConfig | TaskHandler,
  maybeHandler?: TaskHandler,
): TaskDefinition {
  const config: ToolConfig = typeof configOrHandler === "function" ? {} : configOrHandler;
  const handler = typeof configOrHandler === "function" ? configOrHandler : maybeHandler;
  if (typeof handler !== "function") {
    throw new ValidationError("tool() requires a handler function.");
  }

  const taskName = config.name ?? (handler.name || "task");
  const options = (config.options ?? []).map((opt) => normalizeOption(taskName, opt));
  const seenFlags = new Set<string>();
  for (const opt of options) {
    if (seenFlags.has(opt.flagName)) {
      throw new ValidationError(`Duplicate option '${opt.flagName}' in task '${taskName}'.`);
    }
    seenFlags.add(opt.flagName);
  }

  const def: TaskDefinition = {
    kind: "tasknest.tool",
    name: taskName,
    depends: [...(config.depends ?? [])],
    marks: [...(config.marks ?? [])],
    requires: [...(config.requires ?? [])],
    description: config.description ?? "",
    options,
    handler,
  };
  const current = activeCollectors.at(-1);
  if (current) {
    current.push(def);
  }
  return def;
}

export function coerceOptionValue(option: TaskOption, raw: string): unknown {
  let value: unknown;
  switch (option.baseType) {
    case "string":
    case "path":
      value = raw;
      break;
    case "int": {
      if (!/^[+-]?\d+$/.test(raw)) {
        throw new ValidationError(`Invalid int value for ${option.flagName}: '${raw}'`);
      }
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isSafeInteger(parsed)) {
        throw new ValidationError(`Invalid int value for ${option.flagName}: '${raw}'`);
      }
      value = parsed;
      break;
    }
    case "float": {
      if (raw.trim() === "" || Number.isNaN(Number(raw)) || !Number.isFinite(Number(raw))) {
        throw new ValidationError(`Invalid float value for ${option.flagName}: '${raw}'`);
      }
      value = Number(raw);
      break;
    }
    case "boolean": {
      const lowered = raw.toLowerCase();
      if (lowered === "1" || lowered === "true" || lowered === "yes") {
        value = true;
      } else if (lowered === "0" || lowered === "false" || lowered === "no") {
        value = false;
      } else {
        throw new ValidationError(`Invalid bool value for ${option.flagName}: '${raw}'`);
      }
      break;
    }
  }
  if (option.choices && !option.choices.includes(value as string | number)) {
    throw new ValidationError(
      `Invalid value '${String(value)}' for ${option.flagName}; expected one of ${JSON.stringify(option.choices)}`,
    );
  }
  return value;
}

function assignOption(values: Record<string, unknown>, option: TaskOption, raw: string): void {
  const coerced = coerceOptionValue(option, raw);
  if (option.multiple) {
    const existing = Array.isArray(values[option.name]) ? (values[option.name] as unknown[]) : [];
    existing.push(coerced);
    values[option.name] = existing;
  } else {
    values[option.name] = coerced;
  }
}

export function parseTaskCliArgs(task: TaskDefinition, tokens: readonly string[]): ParsedTaskArgs {
  const byFlag = new Map<string, TaskOption>(task.options.map((opt) => [opt.flagName, opt]));
  const values: Record<string, unknown> = {};
  for (const opt of task.options) {
    if (opt.hasDefault) {
      values[opt.name] = opt.defaultValue;
    } else if (opt.multiple) {
      values[opt.name] = [];
    } else if (opt.optional) {
      values[opt.name] = undefined;
    }
  }

  const positionals: string[] = [];
  let idx = 0;
  while (idx < tokens.length) {
    const token = tokens[idx] as string;
    if (token === "--") {
      positionals.push(...tokens.slice(idx + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      idx += 1;
      continue;
    }

    if (token.startsWith("--no-")) {
      const posOpt = byFlag.get(`--${token.slice(5)}`);
      if (posOpt && posOpt.baseType === "boolean") {
        values[posOpt.name] = false;
        idx += 1;
        continue;
      }
    }

    const eqIndex = token.indexOf("=");
    const flag = eqIndex === -1 ? token : token.slice(0, eqIndex);
    const inlineValue = eqIndex === -1 ? undefined : token.slice(eqIndex + 1);
    const opt = byFlag.get(flag);
    if (!opt) {
      throw new ValidationError(`Unknown option '${flag}' for task '${task.name}'.`);
    }

    if (opt.baseType === "boolean" && inlineValue === undefined) {
      values[opt.name] = true;
      idx += 1;
      continue;
    }

    if (inlineValue !== undefined) {
      assignOption(values, opt, inlineValue);
      idx += 1;
      continue;
    }

    if (idx + 1 >= tokens.length) {
      throw new ValidationError(`Option '${flag}' requires a value.`);
    }
    assignOption(values, opt, tokens[idx + 1] as string);
    idx += 2;
  }

  for (const opt of task.options) {
    if (!opt.hasDefault && !opt.multiple && !opt.optional && !(opt.name in values)) {
      throw new ValidationError(
        `Missing required option '${opt.flagName}' for task '${task.name}'.`,
      );
    }
  }
  return { values, positionals };
}
