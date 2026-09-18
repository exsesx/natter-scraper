import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const root = resolve(import.meta.dir, "..");
const windows = process.platform === "win32";
const compiledFixture = process.env.NATTER_TERMINAL_CLI;

if (compiledFixture && !isAbsolute(compiledFixture)) {
  throw new Error("NATTER_TERMINAL_CLI must be an absolute executable path");
}

const fixtureCommand = compiledFixture
  ? [compiledFixture]
  : [process.execPath, "tests/helpers/terminal-cli.ts"];

// ConPTY redraws text rather than preserving the original escape sequences.
const visible = (text: string) =>
  stripVTControlCharacters(text).replace(/\r?\n/g, "");

async function terminalSession(
  run: (session: {
    spawn(command: string[], env?: Record<string, string>): Bun.Subprocess;
    write(text: string): void;
    resize(): void;
    waitFor(marker: string, from?: number): Promise<void>;
    waitForExit(expected: number): Promise<void>;
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
  const spawn = (command: string[], env: Record<string, string> = {}) => {
    assert(
      !child || child.exitCode !== null,
      "Previous child is still running",
    );

    child = Bun.spawn(command, {
      cwd: root,
      terminal,
      env: { ...process.env, TERM: "xterm-256color", CI: "false", ...env },
    });

    return child;
  };
  const waitForExit = async (expected: number) => {
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
          }, 10_000);
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
    const original = windows ? undefined : await snapshot();

    output = "";

    await run({
      spawn,
      write: (text) => terminal.write(text),
      resize: () => terminal.resize(22, 24),
      async waitFor(marker, from = 0) {
        const deadline = Date.now() + 5_000;

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

    if (original !== undefined) {
      assert.equal(await snapshot(), original, "Terminal modes not restored");
    }
  } finally {
    // Kill before closing ConPTY so older Windows versions cannot block in close.
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
  } = {},
) {
  await terminalSession(async (session) => {
    const child = session.spawn([...fixtureCommand, ...(options.args ?? [])], {
      ...(process.env.NATTER_TERMINAL_PATH !== undefined
        ? { PATH: process.env.NATTER_TERMINAL_PATH }
        : {}),
      ...(options.slow ? { SLOW_FIXTURE: "1" } : {}),
      ...options.env,
    });

    if (options.action || options.signal) {
      await session.waitFor(
        options.slow ? "Discovering catalog" : "Catalog complete",
      );
      session.resize();

      if (options.signal) child.kill(options.signal);
      else if (options.action) session.write(options.action);
    }

    await session.waitForExit(options.expected ?? 0);

    const output = session.output();
    const text = visible(output);

    assert.equal(
      text.includes("Catalog complete"),
      (options.interactive ?? true) && !options.slow,
      output,
    );

    if ((options.expected ?? 0) === 0 && !options.args?.includes("--output")) {
      if (windows) {
        // Exact pipe/file bytes are covered by CLI tests; ConPTY may reflow them.
        for (const marker of [
          "Fixture Laptop",
          "Color phone",
          "Pagination phone",
          "270.18",
        ]) {
          assert(
            text.includes(marker),
            `Missing export content ${marker}: ${output}`,
          );
        }
      } else {
        const match = output.match(
          /(\{"results":\[.*\],"total":270\.18\})\r?\n/,
        );

        assert(match?.[1], output);
        assert.equal(JSON.parse(match[1]).results.length, 4);
      }
    }

    if (options.slow) assert(!text.includes('{"results"'), output);
  });

  console.log(`PASS ${name}`);
}

async function copyFormats(format: string) {
  await terminalSession(async (session) => {
    session.spawn([
      process.execPath,
      "tests/helpers/ui-smoke.ts",
      `--format=${format}`,
    ]);
    await session.waitFor("Catalog complete");

    for (const [key, label] of [
      ["c", format.toUpperCase()],
      ["j", "JSON"],
      ["v", "CSV"],
      ["t", "TSV"],
    ] as const) {
      let from = session.output().length;

      // Clear prior feedback so copying the same format produces another redraw.
      session.write("p");
      await session.waitFor("Path copied", from);

      from = session.output().length;
      session.write(key);
      await session.waitFor(`${label} copied`, from);
    }

    session.resize();
    session.write("q");
    await session.waitForExit(0);
    assert(
      !visible(session.output()).includes("Action failed"),
      session.output(),
    );
  });

  console.log(
    `PASS ${format} completion copies all formats with mocked clipboard`,
  );
}

if (windows) {
  console.log(
    "SKIP full termios restoration: Windows has no termios; console mode restoration is not verified",
  );
  console.log(
    "SKIP POSIX SIGTERM cases: Windows process termination is not an equivalent signal test",
  );
}

for (const format of ["json", "csv", "tsv"]) await copyFormats(format);

for (let attempt = 1; attempt <= 3; attempt++) {
  await terminalCase(`stdout completion, resize, Enter (${attempt}/3)`, {
    action: "\r",
  });
}

await terminalCase("completion Ctrl+C", { action: "\x03", expected: 130 });
await terminalCase("running Ctrl+C", {
  action: "\x03",
  expected: 130,
  slow: true,
});

if (!windows) {
  await terminalCase("completion SIGTERM", {
    signal: "SIGTERM",
    expected: 143,
  });
  await terminalCase("running SIGTERM", {
    signal: "SIGTERM",
    expected: 143,
    slow: true,
  });
}

await terminalCase("terminal opt-out", {
  args: ["--no-interactive"],
  interactive: false,
});
await terminalCase("terminal CI", { env: { CI: "1" }, interactive: false });

const directory = await mkdtemp(join(tmpdir(), "natter-terminal-"));

try {
  const destination = join(directory, "products.json");

  await terminalCase("saved completion q", {
    args: ["--output", destination],
    action: "q",
  });
  assert.equal(JSON.parse(await readFile(destination, "utf8")).total, 270.18);
} finally {
  await rm(directory, { recursive: true, force: true });
}
