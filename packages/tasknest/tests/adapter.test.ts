import { createRuntimeAdapter, isBunRuntime } from "@/src/adapter";
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
