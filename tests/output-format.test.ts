import { expect, test } from "bun:test";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { resolveOutputFormat } from "../src/output-format";

test.each([
  { path: undefined, expected: "json" },
  { path: "-", expected: "json" },
  { path: "catalog.json", expected: "json" },
  { path: "catalog.CsV", expected: "csv" },
  { path: "catalog.TSV", expected: "tsv" },
  { path: join("folder.csv", "a file.json"), expected: "json" },
  { path: ".catalog.json", expected: "json" },
])("auto resolves $path to $expected", async ({ path, expected }) => {
  expect(await Effect.runPromise(resolveOutputFormat("auto", path))).toBe(
    expected,
  );
});

test.each([
  "catalog",
  ".json",
  "catalog.",
  "catalog.xml",
  "catalog.json.gz",
  "catalog.csv ",
  join("folder.csv", "catalog"),
])("auto rejects unsupported filename %s with a typed error", async (path) => {
  const result = await Effect.runPromiseExit(resolveOutputFormat("auto", path));

  expect(Exit.isFailure(result)).toBe(true);

  if (Exit.isFailure(result)) {
    const reason = result.cause.reasons[0];

    expect(reason?._tag).toBe("Fail");

    if (reason?._tag === "Fail") {
      expect(reason.error._tag).toBe("OutputFormatError");
      expect(reason.error.message).toContain(JSON.stringify(path));
      expect(reason.error.message).toContain("--format");
    }
  }
});

test.each(["json", "csv", "tsv"] as const)(
  "explicit %s overrides mismatched, unsupported, or missing extensions",
  async (format) => {
    for (const path of [
      undefined,
      "-",
      "catalog.csv",
      "catalog.xml",
      "catalog",
    ])
      expect(await Effect.runPromise(resolveOutputFormat(format, path))).toBe(
        format,
      );
  },
);
