import { describe, expect, test } from "bun:test";
import { defaultConcurrency } from "../src/concurrency";

// Exercise the actual parser and output streams without launching a browser.
const entrypoint = `
  import { Effect } from "effect";
  import { runCli } from "./src/cli";

  process.exitCode = await Effect.runPromise(runCli(JSON.parse(process.env.TEST_CLI_ARGS), {
    crawl: (options) => {
      process.stderr.write("CRAWL " + JSON.stringify({ concurrency: options.concurrency }) + "\\n");
      return Effect.succeed({
        catalog: { results: [{ name: "Fixture", description: "Observed product.", price: 1 }], total: 1 },
        productCount: 1,
      });
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

  return { stdout, stderr, code };
}

describe("CLI concurrency", () => {
  test.each([
    { args: [], expected: defaultConcurrency() },
    { args: ["--concurrency", "1"], expected: 1 },
    { args: ["--concurrency", "4", "-i"], expected: 4 },
    { args: ["--concurrency=8", "--output", "-"], expected: 8 },
    { args: ["--concurrency", "9007199254740991"], expected: 9007199254740991 },
  ])("forwards $args to crawl as $expected", async ({ args, expected }) => {
    const result = await run(args);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(`CRAWL {"concurrency":${expected}}\n`);
    expect(result.stderr).toContain(`(concurrency ${expected})`);
    expect(result.stdout).toBe(
      '{"results":[{"name":"Fixture","description":"Observed product.","price":1}],"total":1}\n',
    );
    expect(result.stdout).not.toContain("\u001b");
  });

  test.each([
    "0",
    "-1",
    "1.5",
    "2.0",
    "NaN",
    "Infinity",
    "9007199254740992",
    "9007199254740993",
    "1e2",
    "0x10",
    "two",
    "4products",
    "",
    " ",
    "2\n",
  ])("rejects %j before crawling", async (value) => {
    const result = await run([`--concurrency=${value}`]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error:");
    expect(result.stderr).not.toContain("CRAWL");
    expect(result.stderr).not.toContain("Reading the static catalog");
  });

  test("missing value exits before crawling", async () => {
    const result = await run(["--concurrency"]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error:");
    expect(result.stderr).not.toContain("CRAWL");
  });

  test("help states concurrency scope and the ten-minute deadline", async () => {
    const result = await run(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--concurrency");
    expect(result.stdout).toContain("defaults to an automatic limit of 1–6");
    expect(result.stdout).toContain("total RAM / 2 GiB");
    expect(result.stdout).toContain(
      `This machine selects ${defaultConcurrency()}`,
    );
    expect(result.stdout).toContain(
      "Browser resource requests can exceed this count",
    );
    expect(result.stdout).toContain("10min per run");
    expect(result.stdout).not.toContain("5min per run");
    expect(result.stderr).toBe("");
  });
});
