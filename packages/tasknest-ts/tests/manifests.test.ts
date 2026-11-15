import { join } from "node:path";
import { discoverTasks } from "@/src/discovery";
import { ConfigError, DiscoveryError, ValidationError } from "@/src/errors";
import { CliRunner, withIsolatedWorkspace } from "@/src/testing";
import { validateRegistry } from "@/src/validation";
import { expect, test } from "@/tests/test";

const TASKNEST_SRC = join(import.meta.dir, "..", "src", "index.ts");

test("package.json workspaces and pyproject.toml tasks pass strict validation", async () => {
  await withIsolatedWorkspace(
    {
      "tasknest.toml": [
        "[tasknest]",
        "config_version = 1",
        "",
        "[discovery]",
        "workspaces = true",
        "",
        "[[discovery.manifests]]",
        'path = "services/*"',
        'persistent_scripts = ["serve"]',
        'exclude_scripts = ["skip_me"]',
        "",
        "[checks]",
        "strict = true",
        "require_description = true",
        "require_tests = true",
        "require_features = true",
        'unknown_marks = "error"',
        "",
        "[marks]",
        'fast = "Fast"',
        'dev = "Dev"',
      ].join("\n"),
      "package.json": JSON.stringify({ name: "mono", workspaces: ["apps/*"] }),
      "bun.lock": "",
      "apps/web/package.json": JSON.stringify({
        name: "@mono/web",
        scripts: { build: "echo web-build", lint: "echo web-lint" },
        tasknest: {
          tasks: {
            lint: { marks: ["fast"], depends: ["build"] },
            dev: { cmd: ["echo", "dev"], persistent: true, marks: ["dev"] },
          },
        },
      }),
      "services/api/pyproject.toml": [
        "[tool.tasknest.tasks]",
        `lint = { cmd = [${JSON.stringify(process.execPath)}, "-e", "console.log('API_LINT')"], marks = ["fast"] }`,
        `serve = [${JSON.stringify(process.execPath)}, "-e", "console.log('API_SERVE')"]`,
        'skip_me = ["echo", "nope"]',
      ].join("\n"),
    },
    async (root) => {
      const reg = await discoverTasks(root);
      expect(Object.keys(reg.tasks).sort()).toEqual([
        "api.lint",
        "api.serve",
        "web.build",
        "web.dev",
        "web.lint",
      ]);
      expect(reg.tasks["web.lint"]?.definition.depends).toEqual(["web.build"]);
      expect(reg.tasks["web.lint"]?.isManifest).toBe(true);
      expect(reg.tasks["web.lint"]?.packageName).toBe("web");
      expect(reg.tasks["api.serve"]?.definition.persistent).toBe(true);
      expect(reg.tasks["web.dev"]?.definition.persistent).toBe(true);
      expect(() => validateRegistry(reg)).not.toThrow();
    },
  );
});

test("Tier-2 file overrides Tier-1 manifest task and duplicate file tasks fail", async () => {
  await withIsolatedWorkspace(
    {
      "tasknest.toml": [
        "[tasknest]",
        "config_version = 1",
        "[[discovery.roots]]",
        'path = "tools"',
        "[[discovery.manifests]]",
        'path = "apps/*"',
      ].join("\n"),
      "apps/web/package.json": JSON.stringify({
        scripts: { build: "echo manifest-build", test: "echo manifest-test" },
        tasknest: { tasks: { test: { depends: ["build"] } } },
      }),
      "tools/web/build.ts": [
        `import { tool } from ${JSON.stringify(TASKNEST_SRC)};`,
        'export default tool({ name: "build", description: "Tier-2 build override." }, () => {',
        '  console.log("TIER2_OVERRIDE_RAN");',
        "});",
      ].join("\n"),
    },
    async (root) => {
      const reg = await discoverTasks(root);
      expect(reg.tasks["web.build"]?.isManifest).toBe(false);
      expect(reg.tasks["web.build"]?.packageName).toBe("web");
      expect(reg.tasks["web.test"]?.definition.depends).toEqual(["web.build"]);

      const res = await new CliRunner(root).invoke(["run", "-p", "web", "build"]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("TIER2_OVERRIDE_RAN");
      expect(res.stdout).not.toContain("manifest-build");
    },
  );

  await withIsolatedWorkspace(
    {
      "tasknest.toml": [
        "[tasknest]",
        "config_version = 1",
        "[[discovery.roots]]",
        'path = "tools"',
        "[[discovery.roots]]",
        'path = "extra"',
      ].join("\n"),
      "tools/web/build.ts": `import { tool } from ${JSON.stringify(TASKNEST_SRC)}; export default tool(() => {});`,
      "extra/web/build.ts": `import { tool } from ${JSON.stringify(TASKNEST_SRC)}; export default tool(() => {});`,
    },
    async (root) => {
      await expect(discoverTasks(root)).rejects.toThrow(DiscoveryError);
    },
  );
});

test("CLI supports --package/-p and --each filtering across packages", async () => {
  const exe = process.execPath;
  await withIsolatedWorkspace(
    {
      "tasknest.toml": [
        "[tasknest]",
        "config_version = 1",
        "[[discovery.manifests]]",
        'path = "services/*"',
        "[marks]",
        'fast = "Fast"',
      ].join("\n"),
      "services/alpha/pyproject.toml": [
        "[tool.tasknest.tasks]",
        `prep = { cmd = [${JSON.stringify(exe)}, "-e", "console.log('ALPHA_PREP')"] }`,
        `test = { cmd = [${JSON.stringify(exe)}, "-e", "console.log('ALPHA_TEST')"], depends = ["prep"], marks = ["fast"] }`,
      ].join("\n"),
      "services/beta/pyproject.toml": [
        "[tool.tasknest.tasks]",
        `prep = { cmd = [${JSON.stringify(exe)}, "-e", "console.log('BETA_PREP')"] }`,
        `test = { cmd = [${JSON.stringify(exe)}, "-e", "console.log('BETA_TEST')"], depends = ["prep"], marks = ["fast"] }`,
      ].join("\n"),
    },
    async (root) => {
      const runner = new CliRunner(root);

      const lsRes = await runner.invoke(["ls", "-p", "alpha"]);
      expect(lsRes.exitCode).toBe(0);
      expect(lsRes.stdout).toContain("alpha test (alpha.test)");
      expect(lsRes.stdout).not.toContain("beta.test");

      const planRes = await runner.invoke(["plan", "--each", "test"]);
      expect(planRes.exitCode).toBe(0);
      expect(planRes.stdout).toContain("alpha.prep");
      expect(planRes.stdout).toContain("alpha.test");
      expect(planRes.stdout).toContain("beta.test");

      const runEach = await runner.invoke(["run", "--each", "test"]);
      expect(runEach.exitCode).toBe(0);
      expect(runEach.stdout).toContain("ALPHA_PREP");
      expect(runEach.stdout).toContain("ALPHA_TEST");
      expect(runEach.stdout).toContain("BETA_TEST");

      const runPkgMark = await runner.invoke(["run", "-p", "beta", "--mark", "fast"]);
      expect(runPkgMark.exitCode).toBe(0);
      expect(runPkgMark.stdout).toContain("BETA_TEST");
      expect(runPkgMark.stdout).not.toContain("ALPHA_TEST");

      const badCombo = await runner.invoke(["run", "--mark", "fast", "--each", "test"]);
      expect(badCombo.exitCode).toBe(2);

      const wrongPkg = await runner.invoke(["run", "-p", "alpha", "beta", "test"]);
      expect(wrongPkg.exitCode).toBe(2);
    },
  );
});

test("manifest validation rejects missing paths, invalid specs, and unknown marks", async () => {
  await withIsolatedWorkspace(
    {
      "tasknest.toml":
        '[tasknest]\nconfig_version = 1\n[[discovery.manifests]]\npath = "missing_dir"\n',
    },
    async (root) => {
      await expect(discoverTasks(root)).rejects.toThrow(DiscoveryError);
    },
  );

  await withIsolatedWorkspace(
    {
      "tasknest.toml": '[tasknest]\nconfig_version = 1\n[[discovery.manifests]]\npath = "svc"\n',
      "svc/pyproject.toml": '[tool.tasknest.tasks]\nbad = "not_a_list"\n',
    },
    async (root) => {
      await expect(discoverTasks(root)).rejects.toThrow(ConfigError);
    },
  );

  await withIsolatedWorkspace(
    {
      "tasknest.toml": [
        "[tasknest]",
        "config_version = 1",
        "[[discovery.manifests]]",
        'path = "svc"',
        "[checks]",
        "strict = true",
        'unknown_marks = "error"',
      ].join("\n"),
      "svc/pyproject.toml":
        '[tool.tasknest.tasks]\nok = { cmd = ["echo", "hi"], marks = ["ghost"] }\n',
    },
    async (root) => {
      const reg = await discoverTasks(root);
      expect(() => validateRegistry(reg)).toThrow(ValidationError);
    },
  );
});
