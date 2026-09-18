import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConcurrency } from "../src/concurrency";
import { fixturePage, fixturePrefix } from "../tests/helpers/fixture-site";
import { binaryName, compileBinary, nativeTarget, projectRoot } from "./build";

const directory = await mkdtemp(join(tmpdir(), "natter-binary-"));
const emptyPath = join(directory, "empty-path");
const target = nativeTarget();
const production = join(directory, binaryName(target));
const fixture = join(directory, `fixture-${binaryName(target)}`);
const terminalFixture = join(directory, `terminal-${binaryName(target)}`);
const environment: NodeJS.ProcessEnv = { ...process.env };

delete environment.BUN_OPTIONS;
delete environment.BUN_BE_BUN;
delete environment.NODE_OPTIONS;
delete environment.FIXTURE_URL;

async function run(
  binary: string,
  args: string[],
  fixtureUrl?: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  // No Bun, checkout-relative paths, inherited preload options, or desktop tools.
  const env: NodeJS.ProcessEnv = { ...environment, CI: "1", ...extraEnv };

  env.PATH = emptyPath;

  if (fixtureUrl) env.FIXTURE_URL = fixtureUrl;

  const child = Bun.spawn([binary, ...args], {
    cwd: directory,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Let the fixture's 30-second crawl deadline finish cleanup and report errors.
    timeout: 45_000,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  assert.equal(child.signalCode, null, `Binary terminated: ${stderr}`);

  return { stdout, stderr, code };
}

try {
  await mkdir(emptyPath);
  await compileBinary({
    entrypoint: join(projectRoot, "src/main.ts"),
    outfile: production,
  });
  await compileBinary({
    entrypoint: join(projectRoot, "tests/helpers/fixture-cli.ts"),
    outfile: fixture,
  });

  const help = await run(production, ["--help"]);

  assert.equal(help.code, 0);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /--no-interactive/);
  assert.match(help.stdout, /--format/);
  assert.match(help.stdout, /defaults to an automatic limit of 1–6/);
  assert.ok(
    help.stdout.includes(`This machine selects ${defaultConcurrency()}`),
  );
  assert.ok(help.stdout.includes(binaryName(target)));
  assert.ok(!help.stdout.includes("bun run scrape"));

  const version = await run(production, ["--version"]);

  assert.equal(version.code, 0);
  assert.equal(version.stderr, "");
  assert.equal(version.stdout.trim(), "natter-scraper v0.1.0");

  const invalid = await run(production, ["--unknown"]);

  assert.equal(invalid.code, 2);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /error:/);

  // Exercise the production binary before starting any fixture server. An invalid
  // Chrome path makes accidental extraction fail even on hosts with Chrome installed.
  const input = join(directory, "input catalog.json");
  const catalog = {
    results: [{ name: "Saved item", description: "From disk.", price: 12.34 }],
    total: 12.34,
  };
  const original = `${JSON.stringify(catalog, null, 4)}\n`;
  const noChrome = { BUN_CHROME_PATH: join(directory, "missing-chrome") };

  await writeFile(input, original);

  const loaded = await run(
    production,
    ["--input", "input catalog.json"],
    undefined,
    noChrome,
  );

  assert.equal(loaded.code, 0, loaded.stderr);
  assert.equal(loaded.stdout, `${JSON.stringify(catalog)}\n`);
  assert.match(loaded.stderr, /Loaded:/);
  assert.match(loaded.stderr, /1 results/);
  assert.doesNotMatch(loaded.stderr, /products|Discovering|\d+(?:\.\d+)?s\b/);

  const converted = await run(
    production,
    ["--input", "input catalog.json", "--output", "loaded.csv"],
    undefined,
    noChrome,
  );

  assert.equal(converted.code, 0, converted.stderr);
  assert.equal(converted.stdout, "");
  assert.equal(
    await readFile(join(directory, "loaded.csv"), "utf8"),
    "name,description,price,colors\r\nSaved item,From disk.,12.34,\r\n",
  );
  assert.equal(
    await readFile(input, "utf8"),
    original,
    "Reopening or converting rewrote input",
  );

  await writeFile(join(directory, "bad-input.json"), "{ broken");

  const badInput = await run(
    production,
    ["--input", "bad-input.json"],
    undefined,
    noChrome,
  );

  assert.equal(badInput.code, 1);
  assert.equal(badInput.stdout, "");
  assert.match(badInput.stderr, /error:/i);
  assert.doesNotMatch(badInput.stderr, /Chrome|Discovering/);

  let failing = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);

      if (failing && url.pathname.endsWith("/product/3"))
        return new Response("Unavailable", { status: 503 });

      const html = fixturePage(url.pathname, url.search);

      return new Response(html ?? "Missing", {
        status: html ? 200 : 404,
        headers: { "content-type": "text/html" },
      });
    },
  });

  try {
    const fixtureUrl = `http://127.0.0.1:${server.port}${fixturePrefix}`;
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
    const json = await run(fixture, [], fixtureUrl);

    assert.equal(json.code, 0, json.stderr);
    assert.equal(json.stdout, `${JSON.stringify(expected)}\n`);
    assert.match(json.stderr, /3 products, 4 results/);
    assert.ok(json.stderr.includes(`(concurrency ${defaultConcurrency()})`));

    for (const [format, delimiter] of [
      ["csv", ","],
      ["tsv", "\t"],
    ] as const) {
      const result = await run(fixture, ["--format", format], fixtureUrl);
      const rows = [
        ["name", "description", "price", "colors"],
        ["Fixture Laptop (128 GB)", "A laptop & charger.", "100.10", ""],
        ["Fixture Laptop (256 GB)", "A laptop & charger.", "120.10", ""],
        ["Color phone", "A phone.", "24.99", "Black; White"],
        ["Pagination phone", "A phone.", "24.99", ""],
      ];

      assert.equal(result.code, 0, result.stderr);
      assert.equal(
        result.stdout,
        `${rows.map((row) => row.join(delimiter)).join("\r\n")}\r\n`,
      );
    }

    const output = join(directory, "saved catalog.json");

    await writeFile(output, "previous");

    const saved = await run(fixture, ["--output", output], fixtureUrl);

    assert.equal(saved.code, 0, saved.stderr);
    assert.equal(saved.stdout, "");
    assert.equal(await readFile(output, "utf8"), json.stdout);

    const inferredOutput = join(directory, "inferred.csv");
    const inferred = await run(
      fixture,
      ["--output", inferredOutput],
      fixtureUrl,
    );

    assert.equal(inferred.code, 0, inferred.stderr);
    assert.equal(inferred.stdout, "");
    assert.match(
      await readFile(inferredOutput, "utf8"),
      /^name,description,price,colors\r\n/,
    );

    failing = true;

    for (const args of [
      [],
      ["--format", "csv"],
      ["--format", "tsv"],
      ["--output", output],
    ]) {
      const failure = await run(fixture, args, fixtureUrl);

      assert.equal(failure.code, 1);
      assert.equal(failure.stdout, "");
      assert.match(failure.stderr, /503/);
    }

    assert.equal(await readFile(output, "utf8"), json.stdout);
    assert.equal(
      (await readdir(directory)).some((name) => name.endsWith(".tmp")),
      false,
    );
  } finally {
    await server.stop(true);
  }

  await compileBinary({
    entrypoint: join(projectRoot, "tests/helpers/terminal-cli.ts"),
    outfile: terminalFixture,
  });

  const terminal = Bun.spawn(
    [process.execPath, join(projectRoot, "scripts/verify-terminal.ts")],
    {
      cwd: projectRoot,
      env: {
        ...environment,
        NATTER_TERMINAL_CLI: terminalFixture,
        NATTER_TERMINAL_PATH: emptyPath,
      },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      timeout: 180_000,
      killSignal: "SIGKILL",
    },
  );

  assert.equal(
    await terminal.exited,
    0,
    "Compiled terminal verification failed",
  );

  console.log(
    `Standalone ${target}: help, version, usage, JSON/CSV/TSV, format inference, atomic files, saved catalog loading without Chrome, failure behavior, and browser checks passed. Headless exports ran outside checkout with no Bun on PATH.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
