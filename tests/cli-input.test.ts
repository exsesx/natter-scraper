import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "natter-cli-input-"));
const inputPath = join(directory, "saved catalog with spaces.json");
const catalog = {
  results: [
    {
      name: 'Phone "Blue"',
      description: "A, phone.",
      price: 0.1,
      colors: ["White", "Black"],
    },
    { name: "Second phone", description: "Another phone.", price: 0.2 },
    { name: "Laptop (256 GB)", description: "A laptop.", price: 37.29 },
  ],
  total: 37.59,
};
const original = `${JSON.stringify(catalog, null, 4)}\n`;

await writeFile(inputPath, original);
afterAll(() => rm(directory, { recursive: true, force: true }));

const entrypoint = `
  import { Effect } from "effect";
  import { runCli } from "./src/cli";

  process.exitCode = await Effect.runPromise(runCli(JSON.parse(process.env.TEST_CLI_ARGS), {
    crawl: () => {
      process.stderr.write("UNEXPECTED_CRAWL\\n");
      throw new Error("Imported catalogs must never crawl");
    },
  }));
`;

async function run(args: readonly string[]) {
  const child = Bun.spawn([process.execPath, "--eval", entrypoint], {
    env: { ...process.env, NO_COLOR: "1", TEST_CLI_ARGS: JSON.stringify(args) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(stderr).not.toContain("UNEXPECTED_CRAWL");

  return { stdout, stderr, code };
}

describe("CLI saved catalog input", () => {
  test.each([
    { args: [] },
    { args: ["-i"] },
    { args: ["--no-interactive"] },
    { args: ["--output", "-", "-i"] },
  ])(
    "headless import preserves the whole catalog for $args without modifying its file",
    async ({ args }) => {
      const result = await run(["--input", inputPath, ...args]);

      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`${JSON.stringify(catalog)}\n`);
      expect(result.stdout).not.toContain("\u001b");
      expect(result.stderr).not.toContain("\u001b[?1049h");
      expect(await readFile(inputPath, "utf8")).toBe(original);
    },
  );

  test("pretty import uses two-space JSON without rewriting the original", async () => {
    const result = await run(["--input", inputPath, "--pretty"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${JSON.stringify(catalog, null, 2)}\n`);
    expect(await readFile(inputPath, "utf8")).toBe(original);
  });

  test.each([
    {
      format: "csv",
      expected:
        'name,description,price,colors\r\n"Phone ""Blue""","A, phone.",0.10,White; Black\r\nSecond phone,Another phone.,0.20,\r\nLaptop (256 GB),A laptop.,37.29,\r\n',
    },
    {
      format: "tsv",
      expected:
        'name\tdescription\tprice\tcolors\r\n"Phone ""Blue"""\tA, phone.\t0.10\tWhite; Black\r\nSecond phone\tAnother phone.\t0.20\t\r\nLaptop (256 GB)\tA laptop.\t37.29\t\r\n',
    },
  ])(
    "converts JSON input to $format through stdout or inferred file output",
    async ({ format, expected }) => {
      const streamed = await run(["--input", inputPath, "--format", format]);

      expect(streamed.code).toBe(0);
      expect(streamed.stdout).toBe(expected);

      const path = join(directory, `converted.${format}`);
      const saved = await run(["--input", inputPath, "--output", path]);

      expect(saved.code).toBe(0);
      expect(saved.stdout).toBe("");
      expect(await readFile(path, "utf8")).toBe(expected);
      expect(await readFile(inputPath, "utf8")).toBe(original);
    },
  );

  test("an explicit output format overrides its filename when importing", async () => {
    const path = join(directory, "explicit.csv");
    const result = await run([
      "--input",
      inputPath,
      "-o",
      path,
      "--format",
      "json",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(await readFile(path, "utf8")).toBe(`${JSON.stringify(catalog)}\n`);
  });

  test("explicit output to the input path replaces it only after a valid load", async () => {
    const path = join(directory, "rewrite.json");
    await writeFile(path, original);

    const result = await run(["--input", path, "--output", path, "--pretty"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(await readFile(path, "utf8")).toBe(
      `${JSON.stringify(catalog, null, 2)}\n`,
    );
  });

  test.each([
    { name: "malformed", content: '{"results":[' },
    {
      name: "csv",
      content: "name,description,price,colors\r\nPhone,Description,1.00,\r\n",
    },
    {
      name: "wrong-total",
      content: JSON.stringify({ ...catalog, total: 37.6 }),
    },
    {
      name: "invalid-last-row",
      content: JSON.stringify({
        results: [...catalog.results, { name: "Invalid", price: 1 }],
        total: 38.59,
      }),
    },
  ])(
    "invalid $name input emits no partial output and preserves destinations",
    async ({ name, content }) => {
      const path = join(directory, `${name}.json`);
      const output = join(directory, `${name}-output.json`);
      await writeFile(path, content);
      await writeFile(output, "previous successful export");

      for (const destination of [undefined, output, path]) {
        const result = await run([
          "--input",
          path,
          ...(destination ? ["--output", destination] : []),
        ]);

        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toMatch(/error/i);
        expect(await readFile(path, "utf8")).toBe(content);
        expect(await readFile(output, "utf8")).toBe(
          "previous successful export",
        );
      }
    },
  );

  test("missing input file fails without replacing an existing output", async () => {
    const output = join(directory, "missing-output.json");
    await writeFile(output, "keep this export");

    const result = await run([
      "--input",
      join(directory, "missing.json"),
      "-o",
      output,
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("missing.json");
    expect(await readFile(output, "utf8")).toBe("keep this export");
  });

  test.each(["", "   ", "-"])(
    "rejects unsupported input path %j as usage",
    async (path) => {
      const result = await run(["--input", path]);

      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/error/i);
    },
  );

  test("import still rejects pretty delimited output as invalid usage", async () => {
    const result = await run([
      "--input",
      inputPath,
      "--format",
      "csv",
      "--pretty",
    ]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--pretty");
  });
});
