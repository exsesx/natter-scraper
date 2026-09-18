import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldInteract } from "../src/cli";
import { fixturePage, fixturePrefix } from "./helpers/fixture-site";

// Some cases run two fixture crawls, each with a 30-second deadline.
setDefaultTimeout(75_000);

const expected = {
  results: [
    {
      name: "Fixture Laptop (128 GB)",
      description: "A laptop & charger.",
      price: 100.1,
    },
    {
      name: "Fixture Laptop (256 GB)",
      description: "A laptop & charger.",
      price: 120.1,
    },
    {
      name: "Color phone",
      description: "A phone.",
      price: 24.99,
      colors: ["Black", "White"],
    },
    { name: "Pagination phone", description: "A phone.", price: 24.99 },
  ],
  total: 270.18,
};
const directory = await mkdtemp(join(tmpdir(), "natter-cli-"));

afterAll(() => rm(directory, { recursive: true, force: true }));

async function run(
  args: readonly string[],
  mode: "success" | "failure" = "success",
) {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      requests++;
      const url = new URL(request.url);

      if (mode === "failure" && url.pathname.endsWith("/product/3"))
        return new Response("Down", { status: 503 });

      const html = fixturePage(url.pathname, url.search);

      return new Response(html ?? "Missing", {
        status: html ? 200 : 404,
        headers: { "content-type": "text/html" },
      });
    },
  });

  try {
    const child = Bun.spawn(
      [process.execPath, "tests/helpers/fixture-cli.ts", ...args],
      {
        env: {
          ...process.env,
          CI: "false",
          FIXTURE_URL: `http://127.0.0.1:${server.port}${fixturePrefix}`,
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    child.stdin.end();

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    return { stdout, stderr, code, requests };
  } finally {
    server.stop(true);
  }
}

describe("CLI subprocess contract", () => {
  test("redirected streams exit automatically with one exact catalog", async () => {
    const result = await run([]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`);
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stderr).toContain("3 products, 4 results");
    expect(result.stderr).not.toContain("copy JSON");
  });

  test.each([
    { args: ["-i"] },
    { args: ["--interactive"] },
    { args: ["--output", "-", "-i"] },
  ])(
    "interactive flags preserve clean redirected output for $args",
    async ({ args }) => {
      const result = await run(args);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`);
      expect(result.stderr).toContain("3 products, 4 results");
      expect(result.stderr).not.toContain("\u001b[?1049h");
    },
  );

  test("pretty stdout and explicit opt-out retain the same catalog", async () => {
    const result = await run(["--pretty", "--output", "-", "--no-interactive"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${JSON.stringify(expected, null, 2)}\n`);
  });

  test.each([
    { args: ["--format", "auto"], pretty: false },
    { args: ["--format", "auto", "--pretty"], pretty: true },
    { args: ["--output", "-", "--no-pretty"], pretty: false },
  ])(
    "JSON defaults and pretty overrides for $args",
    async ({ args, pretty }) => {
      const result = await run(args);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe(
        `${JSON.stringify(expected, null, pretty ? 2 : undefined)}\n`,
      );
      expect(result.stderr).not.toContain("copy");
    },
  );

  test.each(["json", "JSON"])(
    "auto infers pretty JSON from .%s before validating --pretty",
    async (extension) => {
      const path = join(directory, `pretty.${extension}`);
      const result = await run(["--output", path, "--pretty"]);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(await readFile(path, "utf8")).toBe(
        `${JSON.stringify(expected, null, 2)}\n`,
      );
    },
  );

  test.each(["override.csv", "override.xml", "override"])(
    "explicit JSON overrides the filename %s",
    async (filename) => {
      const path = join(directory, filename);
      const result = await run(["--format", "json", "--output", path]);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      expect(await readFile(path, "utf8")).toBe(
        `${JSON.stringify(expected)}\n`,
      );
    },
  );

  test.each([
    {
      format: "csv",
      expected:
        "name,description,price,colors\r\nFixture Laptop (128 GB),A laptop & charger.,100.10,\r\nFixture Laptop (256 GB),A laptop & charger.,120.10,\r\nColor phone,A phone.,24.99,Black; White\r\nPagination phone,A phone.,24.99,\r\n",
    },
    {
      format: "tsv",
      expected:
        "name\tdescription\tprice\tcolors\r\nFixture Laptop (128 GB)\tA laptop & charger.\t100.10\t\r\nFixture Laptop (256 GB)\tA laptop & charger.\t120.10\t\r\nColor phone\tA phone.\t24.99\tBlack; White\r\nPagination phone\tA phone.\t24.99\t\r\n",
    },
  ])(
    "$format exports the complete fixture to stdout and a file",
    async ({ format, expected }) => {
      const result = await run(["--format", format]);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe(expected);
      expect(result.stderr).toContain("$270.18");
      expect(result.stderr).not.toContain("copy");

      const path = join(directory, `products.${format}`);
      const saved = await run(["--format", format, "--output", path]);

      expect(saved.code, saved.stderr).toBe(0);
      expect(saved.stdout).toBe("");
      expect(await readFile(path, "utf8")).toBe(expected);

      const inferredPath = join(directory, `inferred.${format.toUpperCase()}`);
      const inferred = await run(["--output", inferredPath, "--no-pretty"]);

      expect(inferred.code, inferred.stderr).toBe(0);
      expect(inferred.stdout).toBe("");
      expect(await readFile(inferredPath, "utf8")).toBe(expected);
    },
  );

  test.each(["csv", "tsv"])(
    "%s emits no header or rows after a crawl failure",
    async (format) => {
      const result = await run(["--format", format], "failure");

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("503");
    },
  );

  test("file output replaces a prior result and keeps stdout empty", async () => {
    const path = join(directory, "spaces and $dollars.json");

    await writeFile(path, "old");

    const result = await run(["--output", path]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(expected);
    expect(
      (await readdir(directory)).some((entry) => entry.endsWith(".tmp")),
    ).toBe(false);
  });

  test("required product failure emits no JSON and preserves a saved result", async () => {
    const path = join(directory, "previous.json");

    await writeFile(path, "previous successful result");

    const result = await run(["-o", path], "failure");

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("503");
    expect(result.stderr).toContain("/product/3");
    expect(await readFile(path, "utf8")).toBe("previous successful result");

    const stdoutFailure = await run([], "failure");

    expect(stdoutFailure.code).toBe(1);
    expect(stdoutFailure.stdout).toBe("");
  });

  test("output failure is actionable and nonzero", async () => {
    const result = await run(["-o", join(directory, "missing", "output.json")]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("parent directory");
  });

  test.each([
    { args: ["--unknown"] },
    { args: ["unexpected-positional"] },
    { args: ["--output"] },
    { args: ["--output", ""] },
    { args: ["--output", "   "] },
    { args: ["--output", "products"] },
    { args: ["--output", "products.xml"] },
    { args: ["--output", "products.json.gz"] },
    { args: ["--format"] },
    { args: ["--format", "xml"] },
    { args: ["--format", "csv", "--pretty"] },
    { args: ["--pretty", "--format", "tsv"] },
    { args: ["--pretty", "--output", "products.csv"] },
    { args: ["--format", "auto", "--output", "products.tsv", "--pretty"] },
  ])("invalid arguments %j exit 2", async ({ args }) => {
    const result = await run(args);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error:");
    expect(result.requests).toBe(0);
  });

  test("version exits without starting a crawl or writing to stderr", async () => {
    const result = await run(["--version"], "failure");

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("natter-scraper v0.1.0");
    expect(result.stderr).toBe("");
    expect(result.requests).toBe(0);
  });

  test("help describes streams and keys without starting a crawl", async () => {
    const result = await run(["--help"], "failure");

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("--no-interactive");
    expect(result.stdout).toContain("-i / --interactive");
    expect(result.stdout).toContain("--output FILE saves and exits");
    expect(result.stdout).toContain("Exit codes:");
    expect(result.stdout).toContain("--format");
    expect(result.stderr).toBe("");
    expect(result.requests).toBe(0);
  });
});

test.each([
  { outputPath: undefined, interactive: undefined, expected: true },
  { outputPath: undefined, interactive: true, expected: true },
  { outputPath: undefined, interactive: false, expected: false },
  { outputPath: "test.json", interactive: undefined, expected: false },
  { outputPath: "test.json", interactive: true, expected: true },
  { outputPath: "test.json", interactive: false, expected: false },
  { outputPath: "-", interactive: undefined, expected: false },
  { outputPath: "-", interactive: true, expected: false },
  { outputPath: "-", interactive: false, expected: false },
])(
  "terminal interaction policy for $outputPath and $interactive",
  ({ outputPath, interactive, expected }) => {
    expect(
      shouldInteract({
        interactive,
        ...(outputPath !== undefined ? { outputPath } : {}),
        stdinTTY: true,
        stdoutTTY: true,
        stderrTTY: true,
      }),
    ).toBe(expected);
  },
);

test("interaction requires all three TTYs and no explicit opt-out", () => {
  for (const stdinTTY of [false, true])
    for (const stdoutTTY of [false, true])
      for (const stderrTTY of [false, true]) {
        expect(
          shouldInteract({ interactive: true, stdinTTY, stdoutTTY, stderrTTY }),
        ).toBe(stdinTTY && stdoutTTY && stderrTTY);
      }

  expect(shouldInteract({ interactive: true })).toBe(false);
  expect(
    shouldInteract({
      interactive: false,
      stdinTTY: true,
      stdoutTTY: true,
      stderrTTY: true,
    }),
  ).toBe(false);
});

test("dumb terminals disable interaction", () => {
  const terminals = {
    interactive: true,
    stdinTTY: true,
    stdoutTTY: true,
    stderrTTY: true,
  };

  for (const term of ["dumb", "DUMB"])
    expect(shouldInteract({ ...terminals, term })).toBe(false);

  expect(shouldInteract({ ...terminals, term: "xterm-256color" })).toBe(true);
});

test("CI disables interaction except unset, empty, 0, or false", () => {
  const terminals = {
    interactive: true,
    stdinTTY: true,
    stdoutTTY: true,
    stderrTTY: true,
  };

  for (const ci of ["", "0", "false", "FALSE"])
    expect(shouldInteract({ ...terminals, ci })).toBe(true);

  for (const ci of ["1", "true", "yes", "build", " "])
    expect(shouldInteract({ ...terminals, ci })).toBe(false);
});
