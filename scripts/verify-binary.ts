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

async function run(binary: string, args: string[], fixtureUrl?: string) {
  // No Bun, checkout-relative paths, inherited preload options, or desktop tools.
  const env: NodeJS.ProcessEnv = { ...environment, CI: "1" };

  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") delete env[key];
  }

  env.PATH = emptyPath;

  if (fixtureUrl) env.FIXTURE_URL = fixtureUrl;

  const child = Bun.spawn([binary, ...args], {
    cwd: directory,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
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
    `Standalone ${target}: help, version, usage, JSON/CSV/TSV, format inference, atomic files, failure behavior, and browser checks passed. Headless exports ran outside checkout with no Bun on PATH.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
