import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const root = resolve(import.meta.dir, "..");
const compiledFixture = process.env.NATTER_TERMINAL_CLI;
// Allow the fixture's 30-second crawl deadline plus startup and cleanup.
const crawlCompletionTimeoutMs = 45_000;

if (compiledFixture && !isAbsolute(compiledFixture)) {
  throw new Error("NATTER_TERMINAL_CLI must be an absolute executable path");
}

const fixtureCommand = compiledFixture
  ? [compiledFixture]
  : [process.execPath, join(root, "tests/helpers/terminal-cli.ts")];
const keys = {
  down: "\x1b[B",
  home: "\x1b[H",
  end: "\x1b[F",
  pageDown: "\x1b[6~",
  escape: "\x1b",
  enter: "\r",
  tab: "\t",
  shiftTab: "\x1b[Z",
};

// This is a transcript, not a terminal emulator.
const visible = (text: string) =>
  stripVTControlCharacters(text).replace(/\r?\n/g, "");

async function terminalSession(
  run: (session: {
    spawn(
      command: string[],
      env?: Record<string, string>,
      cwd?: string,
    ): Bun.Subprocess;
    write(text: string): void;
    resize(columns: number, rows: number): void;
    waitFor(marker: string, from?: number, timeoutMs?: number): Promise<void>;
    waitForExit(expected: number, timeoutMs?: number): Promise<void>;
    output(): string;
  }) => Promise<void>,
) {
  let output = "";
  let child: Bun.Subprocess | undefined;
  const decoder = new TextDecoder();
  const terminal = new Bun.Terminal({
    cols: 80,
    rows: 30,
    data(_terminal, bytes) {
      output += decoder.decode(bytes, { stream: true });
    },
  });
  const spawn = (
    command: string[],
    env: Record<string, string> = {},
    cwd = root,
  ) => {
    assert(
      !child || child.exitCode !== null,
      "Previous child is still running",
    );

    child = Bun.spawn(command, {
      cwd,
      terminal,
      env: { ...process.env, TERM: "xterm-256color", CI: "false", ...env },
    });

    return child;
  };
  const waitForExit = async (expected: number, timeoutMs = 10_000) => {
    assert(child, "No terminal child");

    const active = child;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const code = await Promise.race([
        active.exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            active.kill("SIGKILL");
            reject(new Error(`Terminal child did not exit: ${output}`));
          }, timeoutMs);
        }),
      ]);

      assert.equal(code, expected, output);
      // A reusable PTY stays open after child exit; allow the final data callback.
      await Bun.sleep(30);
    } finally {
      clearTimeout(timer);
    }
  };
  const snapshot = async () => {
    const from = output.length;

    spawn(["stty", "-g"]);
    await waitForExit(0);

    const state = output.slice(from).trim();

    assert(state, "stty returned no terminal state");

    return state;
  };

  try {
    const original = await snapshot();

    output = "";

    await run({
      spawn,
      write: (text) => terminal.write(text),
      resize: (columns, rows) => {
        terminal.resize(columns, rows);

        // Deliver the POSIX resize notification explicitly for this reusable PTY.
        if (child?.exitCode === null) child.kill("SIGWINCH");
      },
      async waitFor(marker, from = 0, timeoutMs = 15_000) {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
          if (visible(output.slice(from)).includes(marker)) return;

          if (child?.exitCode !== null) break;

          await Bun.sleep(10);
        }

        throw new Error(`Missing terminal marker ${marker}: ${output}`);
      },
      waitForExit,
      output: () => output,
    });

    assert.equal(await snapshot(), original, "Terminal modes not restored");
  } finally {
    // Stop the child before releasing its terminal.
    try {
      if (child && child.exitCode === null) {
        child.kill("SIGKILL");
        await Promise.race([
          child.exited,
          Bun.sleep(2_000).then(() => {
            throw new Error("Terminal child did not exit after SIGKILL");
          }),
        ]);
      }
    } finally {
      terminal.close();
    }
  }
}

type Session = Parameters<Parameters<typeof terminalSession>[0]>[0];

function startFixture(
  session: Session,
  args: string[] = [],
  env: Record<string, string> = {},
  cwd = root,
) {
  return session.spawn(
    [...fixtureCommand, ...args],
    {
      ...(process.env.NATTER_TERMINAL_PATH !== undefined
        ? { PATH: process.env.NATTER_TERMINAL_PATH }
        : {}),
      ...env,
    },
    cwd,
  );
}

async function press(session: Session, key: string, marker: string) {
  const from = session.output().length;

  session.write(key);
  await session.waitFor(marker, from);
}

function assertAlternateScreenRestored(output: string) {
  const entered = output.indexOf("\x1b[?1049h");
  const exited = output.lastIndexOf("\x1b[?1049l");

  assert(entered >= 0, "Browser did not enter the alternate screen");
  assert(exited > entered, "Browser did not restore the main screen");
}

function finalSummary(output: string, prefix = "Completed:") {
  const text = visible(output);
  const start = text.lastIndexOf(prefix);

  assert(start >= 0, "No summary after leaving the browser");

  return text.slice(start);
}

async function browserNavigation(directory: string) {
  await terminalSession(async (session) => {
    startFixture(session, [], {}, directory);
    await session.waitFor("Catalog complete", 0, crawlCompletionTimeoutMs);
    await session.waitFor("Fixture Laptop");

    assert(
      !session.output().includes('{"results":'),
      "Catalog dumped before browsing",
    );
    assert.deepEqual(
      await readdir(directory),
      [],
      "Browser saved without a request",
    );

    await press(session, keys.enter, "A laptop & charger.");
    await press(session, keys.escape, "Fixture Laptop");
    await press(session, keys.tab, '"results": [');
    await press(session, keys.end, '"total": 270.18');
    await press(session, keys.home, '"results": [');
    await press(session, "r", '{"results":[');
    await press(session, "r", '"results": [');
    await press(session, keys.tab, "Fixture Laptop");
    await press(session, "?", "Help ·");
    await press(session, keys.escape, "Fixture Laptop");

    let from = session.output().length;

    session.resize(42, 15);
    await session.waitFor("Terminal too small", from);
    from = session.output().length;
    session.resize(42, 18);
    await session.waitFor("Fixture Laptop", from);
    await press(session, keys.end, "Pagination phone");
    session.resize(80, 30);
    await press(session, keys.home, "Fixture Laptop");

    session.write("q");
    await session.waitForExit(0);

    assertAlternateScreenRestored(session.output());
    assert.deepEqual(
      await readdir(directory),
      [],
      "Browsing created an export file",
    );
    assert(
      finalSummary(session.output()).toLowerCase().includes("no file saved"),
      session.output(),
    );
  });

  console.log(
    "PASS browser table, details, whole JSON, help, resize, and explicit exit without saving",
  );
}

async function boundedBrowserAndDesktopActions() {
  await terminalSession(async (session) => {
    session.spawn([process.execPath, join(root, "tests/helpers/ui-smoke.ts")]);
    await session.waitFor("Browser product 01");

    const initial = visible(session.output());

    assert(
      !initial.includes("Browser product 40"),
      "Browser rendered every row at once",
    );
    assert(
      !initial.includes('{"results":'),
      "Browser dumped JSON before selection",
    );

    await press(session, "G", "Browser product 40");
    await press(session, keys.enter, "Details for product 40");
    await press(session, "[", "Details for product 39");
    await press(session, "]", "Details for product 40");
    await press(session, keys.escape, "Browser product 40");
    await press(session, "g", "Browser product 01");
    await press(session, "d", "Row 6 of 40");
    await press(session, "u", "Row 1 of 40");
    await press(session, "\x04", "Row 6 of 40");
    await press(session, "\x15", "Row 1 of 40");
    await press(session, " ", "Row 11 of 40");
    await press(session, "b", "Row 1 of 40");
    await press(session, keys.down, "Row 2 of 40");
    await press(session, keys.pageDown, "of 40");

    for (const [key, label] of [
      ["j", "JSON"],
      ["v", "CSV"],
      ["t", "TSV"],
    ] as const) {
      await press(session, key, `${label} copied`);
    }

    await press(session, "c", "Copy catalog");
    await press(session, keys.down, "› JSON");
    await press(session, keys.down, "› CSV");
    await press(session, keys.enter, "CSV copied");
    await press(session, "p", "Path copied");
    await press(session, "f", "File open requested");
    await press(session, "o", "Folder open requested");

    session.resize(42, 18);
    await press(session, keys.home, "Browser product 01");
    session.resize(80, 30);
    await press(session, keys.end, "Browser product 40");
    session.write("q");
    await session.waitForExit(0);

    assertAlternateScreenRestored(session.output());
    assert(
      !visible(session.output()).includes("Action failed"),
      session.output(),
    );
  });

  console.log(
    "PASS bounded browser navigation and JSON/CSV/TSV copy, path, file, folder actions with mocks",
  );
}

async function setSavePath(session: Session, path: string) {
  session.write("\x15");
  // Give the editor a separate input event for clearing and pasting the path.
  await Bun.sleep(30);
  await press(session, path, path);
}

async function confirmSave(session: Session, path: string) {
  const marker = `Saved ${path}`;

  // Keep the complete destination visible so an earlier save cannot acknowledge
  // this one. Catalog rows also redraw while the asynchronous write is pending.
  session.resize(Math.max(80, marker.length + 4), 30);
  await press(session, keys.enter, marker);
}

async function browserSaves(directory: string) {
  await terminalSession(async (session) => {
    startFixture(session, [], {}, directory);
    await session.waitFor("Catalog complete", 0, crawlCompletionTimeoutMs);
    await press(session, "s", "Save catalog");
    await setSavePath(session, "saved catalog.json");
    await confirmSave(session, join(directory, "saved catalog.json"));

    const saved = JSON.parse(
      await readFile(join(directory, "saved catalog.json"), "utf8"),
    );

    assert.equal(saved.results.length, 4);
    assert.equal(saved.total, 270.18);

    await press(session, "s", "Save catalog");
    await setSavePath(session, "saved catalog.json");
    await press(session, keys.enter, "Replace existing file?");
    await press(session, keys.escape, "Save catalog");
    await press(session, keys.escape, "Fixture Laptop");

    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "saved catalog.json"), "utf8")),
      saved,
      "Declining replacement modified the saved catalog",
    );

    await press(session, "s", "Save catalog");
    await setSavePath(session, "missing/catalog.json");
    await press(session, keys.enter, "Could not save");
    await press(session, keys.escape, "Fixture Laptop");

    assert.deepEqual(
      await readdir(directory),
      ["saved catalog.json"],
      "Failed save left an artifact",
    );

    await press(session, "s", "Save catalog");
    await setSavePath(session, "compact.json");
    await press(session, keys.shiftTab, "Format: JSON pretty");
    await press(session, keys.shiftTab, "Format: JSON compact");
    await confirmSave(session, join(directory, "compact.json"));

    assert.equal(
      await readFile(join(directory, "compact.json"), "utf8"),
      `${JSON.stringify(saved)}\n`,
    );

    await press(session, "s", "Save catalog");
    await setSavePath(session, "pretty.json");
    await press(session, keys.shiftTab, "Format: JSON pretty");
    await confirmSave(session, join(directory, "pretty.json"));

    assert.equal(
      await readFile(join(directory, "pretty.json"), "utf8"),
      `${JSON.stringify(saved, null, 2)}\n`,
    );

    await press(session, "s", "Save catalog");
    await setSavePath(session, "overridden.txt");
    await press(session, keys.tab, "Format: CSV");
    await confirmSave(session, join(directory, "overridden.txt"));

    const csv = await readFile(join(directory, "overridden.txt"), "utf8");

    assert(csv.startsWith("name,description,price,colors\r\n"), csv);
    assert.equal(csv.split("\r\n").length, 6);

    session.write("q");
    await session.waitForExit(0);

    assertAlternateScreenRestored(session.output());
    assert(
      finalSummary(session.output()).includes("overridden.txt"),
      session.output(),
    );
  });

  console.log(
    "PASS real browser save, actionable failure, format override, and retained saved file",
  );
}

async function browserLoads(directory: string) {
  const catalog = {
    results: [
      {
        name: "Saved laptop",
        description: "Saved laptop description.",
        price: 12.34,
      },
      {
        name: "Saved phone",
        description: "Saved phone description.",
        price: 5.66,
        colors: ["Black", "White"],
      },
    ],
    total: 18,
  };
  const input = join(directory, "reopen.json");
  const original = `${JSON.stringify(catalog, null, 4)}\n`;
  const env = {
    FORBID_CRAWL: "1",
    BUN_CHROME_PATH: join(directory, "missing-chrome"),
  };

  await writeFile(input, original);
  await terminalSession(async (session) => {
    startFixture(session, ["--input", "reopen.json"], env, directory);
    await session.waitFor("Catalog loaded");
    await session.waitFor("Saved laptop");
    await session.waitFor("f - Open  o - Folder  p - Copy path");

    assert.equal(
      await readFile(input, "utf8"),
      original,
      "Opening rewrote input",
    );
    assert.doesNotMatch(
      visible(session.output()),
      /Discovering catalog|\d+ products|· \d+(?:\.\d+)?s/,
    );

    await press(session, keys.enter, "Saved laptop description.");
    await press(session, "]", "Saved phone description.");
    await press(session, keys.escape, "Saved phone");
    await press(session, keys.tab, '"results": [');
    await press(session, keys.tab, "Saved phone");
    await press(session, "s", "Save catalog");
    await setSavePath(session, "reopen.json");
    await press(session, keys.enter, "Replace existing file?");
    await press(session, keys.escape, "Save catalog");
    await press(session, keys.escape, "Saved phone");

    assert.equal(
      await readFile(input, "utf8"),
      original,
      "Declining replacement rewrote input",
    );

    await press(session, "s", "Save catalog");
    await setSavePath(session, "reopened-products-0s.json");
    await confirmSave(session, join(directory, "reopened-products-0s.json"));

    assert.deepEqual(
      JSON.parse(
        await readFile(join(directory, "reopened-products-0s.json"), "utf8"),
      ),
      catalog,
    );
    assert.equal(await readFile(input, "utf8"), original);
    session.write("q");
    await session.waitForExit(0);
    assertAlternateScreenRestored(session.output());

    const summary = finalSummary(session.output(), "Loaded:");

    assert(summary.includes("reopened-products-0s.json"), summary);
    assert(summary.startsWith("Loaded: 2 results, $18.00; saved "), summary);
  });
  console.log(
    "PASS saved catalog opens without crawling, navigates, preserves input, and confirms replacement",
  );

  const malformed = join(directory, "malformed.json");

  await writeFile(malformed, "{ broken");
  await terminalSession(async (session) => {
    startFixture(session, ["--input", "malformed.json"], env, directory);
    await session.waitForExit(1);

    assert(
      !session.output().includes("\x1b[?1049h"),
      "Invalid input opened the browser",
    );
    assert.doesNotMatch(
      visible(session.output()),
      /Catalog loaded|Discovering catalog|Crawl forbidden/,
    );
    assert.match(visible(session.output()), /error:/i);
    assert.equal(await readFile(malformed, "utf8"), "{ broken");
  });
  console.log(
    "PASS malformed saved catalog fails before entering the alternate screen",
  );
}

async function terminalCase(
  name: string,
  options: {
    args?: string[];
    env?: Record<string, string>;
    action?: string;
    signal?: "SIGTERM";
    expected?: number;
    slow?: boolean;
    interactive?: boolean;
    savedPath?: string;
  } = {},
) {
  await terminalSession(async (session) => {
    const child = startFixture(session, options.args, {
      ...(options.slow ? { SLOW_FIXTURE: "1" } : {}),
      ...options.env,
    });

    if (options.action || options.signal) {
      await session.waitFor(
        options.slow ? "Discovering catalog" : "Catalog complete",
        0,
        options.slow ? undefined : crawlCompletionTimeoutMs,
      );
      session.resize(42, 18);

      if (options.signal) child.kill(options.signal);
      else if (options.action) session.write(options.action);
    }

    await session.waitForExit(
      options.expected ?? 0,
      options.action || options.signal ? undefined : crawlCompletionTimeoutMs,
    );

    const output = session.output();
    const text = visible(output);

    if (options.interactive === false) {
      assert(!output.includes("\x1b[?1049h"), output);

      if (options.savedPath) {
        const saved = JSON.parse(await readFile(options.savedPath, "utf8"));

        assert.equal(saved.results.length, 4);
        assert.equal(saved.total, 270.18);
        assert(!text.includes('{"results":'), output);
        assert(finalSummary(output).includes(options.savedPath), output);
      } else {
        const match = output.match(
          /(\{"results":\[.*\],"total":270\.18\})\r?\n/,
        );

        assert(match?.[1], output);
        assert.equal(JSON.parse(match[1]).results.length, 4);
      }
    } else {
      assertAlternateScreenRestored(output);
      assert(!text.includes('{"results":'), output);
    }
  });

  console.log(`PASS ${name}`);
}

const directory = await realpath(
  await mkdtemp(join(tmpdir(), "natter-terminal-")),
);

try {
  await browserNavigation(directory);
  await boundedBrowserAndDesktopActions();
  await browserSaves(directory);
  await browserLoads(directory);
  await terminalCase("browser Ctrl+C", { action: "\x03", expected: 130 });
  await terminalCase("running Ctrl+C", {
    action: "\x03",
    expected: 130,
    slow: true,
  });

  await terminalCase("browser SIGTERM", { signal: "SIGTERM", expected: 143 });
  await terminalCase("running SIGTERM", {
    signal: "SIGTERM",
    expected: 143,
    slow: true,
  });

  await terminalCase("explicit stdout bypasses the browser", {
    args: ["--output", "-"],
    interactive: false,
  });
  await terminalCase("explicit stdout overrides interactive opt-in", {
    args: ["--output", "-", "-i"],
    interactive: false,
  });
  await terminalCase("terminal opt-out", {
    args: ["--no-interactive"],
    interactive: false,
  });
  await terminalCase("terminal CI", { env: { CI: "1" }, interactive: false });
  await terminalCase("terminal CI overrides interactive opt-in", {
    args: ["--interactive"],
    env: { CI: "1" },
    interactive: false,
  });
  await terminalCase("dumb terminal overrides interactive opt-in", {
    args: ["-i"],
    env: { TERM: "dumb" },
    interactive: false,
  });

  const destination = join(directory, "initial.json");

  await terminalCase("file output saves and exits by default", {
    args: ["-o", destination],
    interactive: false,
    savedPath: destination,
  });

  for (const flag of ["-i", "--interactive"]) {
    await terminalCase(`file output with ${flag} opens the browser`, {
      args: ["--output", destination, flag],
      action: "q",
    });
    assert.equal(JSON.parse(await readFile(destination, "utf8")).total, 270.18);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
