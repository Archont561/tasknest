import { createRuntimeAdapter, isBunRuntime, parseTomlWith } from "@/src/adapter";
import { ConfigError } from "@/src/errors";
import { expect, test } from "@/tests/test";

test("createRuntimeAdapter detects Bun by default and allows explicit runtime selection", () => {
  expect(isBunRuntime()).toBe(true);

  const autoAdapter = createRuntimeAdapter();
  expect(autoAdapter.runtime).toBe("bun");
  expect(autoAdapter.parseToml("key = 1\n")).toEqual({ key: 1 });

  const nodeAdapter = createRuntimeAdapter("node");
  expect(nodeAdapter.runtime).toBe("node");
  expect(nodeAdapter.parseToml("key = 1\n")).toEqual({ key: 1 });
});

test("parseTomlWith rejects parser failures and non-table roots with ConfigError", () => {
  expect(() =>
    parseTomlWith(() => {
      throw new Error("syntax error");
    }, "bad"),
  ).toThrow(ConfigError);
  expect(() => parseTomlWith(() => ["not-a-table"], "x")).toThrow(ConfigError);
  expect(() => parseTomlWith(() => null, "x")).toThrow(ConfigError);
});
