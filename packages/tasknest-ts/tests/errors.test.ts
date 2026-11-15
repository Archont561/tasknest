import {
  ConfigError,
  DependencyError,
  DiscoveryError,
  NotImplementedError,
  TasknestError,
  ToolError,
  ValidationError,
} from "@/src/errors";
import { expect, test } from "@/tests/test";

test("error hierarchy assigns expected names and exit codes", () => {
  const cases: Array<[TasknestError, number]> = [
    [new ConfigError("bad config"), 2],
    [new DiscoveryError("bad discovery"), 2],
    [new ValidationError("bad arg"), 2],
    [new DependencyError("cycle"), 2],
    [new ToolError("boom"), 1],
    [new NotImplementedError("node toml"), 2],
  ];

  for (const [err, expectedExit] of cases) {
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TasknestError);
    expect(err.exitCode).toBe(expectedExit);
  }
});

test("base TasknestError defaults to exit code 2 and custom exit code", () => {
  const base = new TasknestError("generic");
  expect(base.exitCode).toBe(2);
  expect(base.name).toBe("TasknestError");

  const custom = new ToolError("failed", 42);
  expect(custom.exitCode).toBe(42);
  expect(custom.name).toBe("ToolError");
});
