import { expect, test } from "bun:test";
import { version } from "../src/index";

test("exports a development version", () => {
  expect(version).toEndWith("-dev.0");
});
