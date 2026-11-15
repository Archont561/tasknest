import { ValidationError } from "@/src/errors";
import { coerceOptionValue, createDefaultArgValues, parseTaskCliArgs, tool } from "@/src/task";
import { expect, test } from "@/tests/test";

test("tool builds TaskDefinition with normalized CLI flags and metadata", () => {
  const lint = tool(
    {
      name: "lint",
      depends: ["format.check"],
      marks: ["fast"],
      requires: ["ruff"],
      description: "Lint the workspace.",
      options: [
        { name: "path", type: "path", default: "." },
        { name: "dry_run", type: "boolean", default: false },
        { name: "tag", type: "string", multiple: true },
        { name: "mode", type: "string", choices: ["fast", "full"], default: "fast" },
      ],
    },
    async () => {},
  );

  expect(lint.name).toBe("lint");
  expect(lint.depends).toEqual(["format.check"]);
  expect(lint.marks).toEqual(["fast"]);
  expect(lint.requires).toEqual(["ruff"]);
  expect(lint.description).toBe("Lint the workspace.");
  expect(lint.options.map((o) => o.flagName)).toEqual(["--path", "--dry-run", "--tag", "--mode"]);

  const parsed = parseTaskCliArgs(lint, [
    "--path",
    "src",
    "--dry-run",
    "--tag",
    "a",
    "--tag=b",
    "--mode",
    "full",
    "--",
    "extra",
  ]);
  expect(parsed.values).toEqual({
    path: "src",
    dry_run: true,
    tag: ["a", "b"],
    mode: "full",
  });
  expect(parsed.positionals).toEqual(["extra"]);
});

test("tool rejects unsupported option types and invalid CLI inputs", () => {
  expect(() =>
    tool(
      {
        name: "bad",
        options: [{ name: "payload", type: "object" as unknown as "string" }],
      },
      async () => {},
    ),
  ).toThrow(ValidationError);

  const reqTask = tool(
    {
      name: "greet",
      options: [{ name: "who", type: "string" }],
    },
    async () => {},
  );

  expect(() => parseTaskCliArgs(reqTask, [])).toThrow(ValidationError);
  expect(() => parseTaskCliArgs(reqTask, ["--unknown"])).toThrow(ValidationError);
});

test.prop(
  "coerceOptionValue parses integers and booleans consistently",
  (fc) => ({
    num: fc.integer({ min: -100_000, max: 100_000 }),
    flag: fc.boolean(),
  }),
  async (_fixtures, { num, flag }) => {
    const intSpec = {
      name: "count",
      flagName: "--count",
      baseType: "int" as const,
      multiple: false,
      optional: false,
      hasDefault: false,
      defaultValue: undefined,
      choices: undefined,
      description: "",
    };
    expect(coerceOptionValue(intSpec, String(num))).toBe(num);
    expect(() => coerceOptionValue(intSpec, "not-an-int")).toThrow(ValidationError);

    const boolSpec = {
      ...intSpec,
      name: "flag",
      flagName: "--flag",
      baseType: "boolean" as const,
    };
    expect(coerceOptionValue(boolSpec, flag ? "true" : "false")).toBe(flag);
  },
  { numRuns: 30 },
);

test("createDefaultArgValues populates defaults, multiples, and optionals", () => {
  const def = tool(
    {
      name: "demo",
      options: [
        { name: "jobs", type: "int", default: 2 },
        { name: "tags", type: "string", multiple: true },
        { name: "note", type: "string", optional: true },
        { name: "required", type: "string" },
      ],
    },
    async () => {},
  );
  expect(createDefaultArgValues(def)).toEqual({
    jobs: 2,
    tags: [],
    note: undefined,
  });
});
