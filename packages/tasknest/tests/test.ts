import { mkdirSync } from "node:fs";
import { test as base, expect } from "@archont561/bun-test-utils";
import { stringify } from "smol-toml";

interface TmpdirFixture {
  readonly dir: string;
  path(...parts: string[]): string;
  write(filename: string, content: string): string;
  read(filename: string): string;
}

export interface WorkspaceHelper {
  readonly root: string;
  writeFile(relPath: string, content: string): string;
  writeToml(data: Record<string, unknown>, relPath?: string): string;
  mkdir(relPath: string): string;
}

export const test: typeof base = base.extend({
  workspace: {
    deps: ["tmpdir"],
    setup: async (use, { tmpdir }) => {
      const tmp = tmpdir as TmpdirFixture;
      const helper: WorkspaceHelper = {
        root: tmp.dir,
        writeFile(relPath: string, content: string): string {
          return tmp.write(relPath, content);
        },
        writeToml(data: Record<string, unknown>, relPath = "tasknest.toml"): string {
          return tmp.write(relPath, stringify(data));
        },
        mkdir(relPath: string): string {
          const full = tmp.path(relPath);
          mkdirSync(full, { recursive: true });
          return full;
        },
      };
      await use(helper);
    },
  },
});

export { expect };
