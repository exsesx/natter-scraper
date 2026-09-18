import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Effect, Exit, Fiber } from "effect";
import { render } from "ink";
import { type DesktopActions, DesktopError } from "../src/desktop";
import { serializeCatalog } from "../src/format";
import type { Completion, Progress } from "../src/types";
import { createTerminalUI, TerminalView } from "../src/ui";

const progress: Progress = {
  phase: "discovering",
  pages: 2,
  discoveredProducts: 3,
  processedProducts: 1,
  queued: 2,
  active: 1,
  retries: 0,
};
const completion: Completion = {
  catalog: {
    results: [
      {
        name: 'Phone, "Gold"',
        description: "A\tB\nC",
        price: 12.34,
        colors: ["Gold", "Blue"],
      },
    ],
    total: 12.34,
  },
  output: '{"results":[],"total":0}\n',
  format: "json",
  pretty: false,
  productCount: 3,
  elapsedMs: 1500,
};
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 35));

async function screen(result?: Completion, desktop?: DesktopActions) {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode(value: boolean): void;
    ref(): void;
    unref(): void;
  };
  const output = new PassThrough() as PassThrough & {
    columns: number;
    rows: number;
    isTTY: boolean;
  };

  input.isTTY = true;

  const raw: boolean[] = [];

  input.setRawMode = (value) => {
    raw.push(value);
  };
  input.ref = () => {};
  input.unref = () => {};
  output.columns = 80;
  output.rows = 30;
  output.isTTY = true;

  const chunks: string[] = [];

  output.on("data", (chunk) => chunks.push(String(chunk)));

  const copies: string[] = [];
  const folders: string[] = [];
  const exits: number[] = [];
  let cancels = 0;
  const instance = render(
    <TerminalView
      progress={progress}
      {...(result ? { completion: result } : {})}
      desktop={
        desktop ?? {
          copy: (text) =>
            Effect.sync(() => {
              copies.push(text);
            }),
          openFolder: (path) =>
            Effect.sync(() => {
              folders.push(path);
            }),
        }
      }
      onCancel={() => {
        cancels++;
      }}
      onClose={(code) => {
        exits.push(code);
      }}
    />,
    {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: output as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
      debug: true,
    },
  );

  cleanups.push(() => {
    instance.unmount();
    input.destroy();
    output.destroy();
  });

  await tick();

  return {
    copies,
    folders,
    exits,
    raw,
    output,
    instance,
    cancels: () => cancels,
    text: () => chunks.join(""),
    async key(value: string) {
      input.write(value);
      await tick();
    },
  };
}

test("running view reports source counts and only Ctrl+C cancels", async () => {
  const view = await screen();

  expect(view.text()).toContain("Discovering catalog");
  expect(view.text()).toContain("1 read");

  await view.key("c");
  await view.key("q");

  expect(view.copies).toEqual([]);
  expect(view.exits).toEqual([]);

  await view.key("\u0003");

  expect(view.cancels()).toBe(1);

  view.instance.unmount();

  expect(view.raw.at(-1)).toBe(false);
});

test("stdout completion copies exact JSON and hides file actions", async () => {
  const view = await screen(completion);

  expect(view.text()).not.toContain("copy path");
  expect(view.text()).not.toContain("open folder");

  await view.key("p");
  await view.key("o");
  await view.key("c");

  expect(view.copies).toEqual([completion.output]);
  expect(view.folders).toEqual([]);
  expect(view.text()).toContain("JSON copied");

  await view.key("q");
  await view.key("\r");
  await view.key("\u0003");

  expect(view.exits).toEqual([0, 0, 130]);
});

test("saved completion uses the successful absolute path and responds to resize", async () => {
  const file = {
    ...completion,
    outputPath: join(tmpdir(), "a folder", "catalog.json"),
  };
  const view = await screen(file);

  await view.key("p");
  await view.key("o");

  expect(view.copies).toEqual([file.outputPath]);
  expect(view.folders).toEqual([file.outputPath]);

  view.output.columns = 24;
  view.output.emit("resize");
  await tick();

  expect(view.text()).toContain("copy JSON");
  expect(view.text()).toContain("Folder open requested");
});

test("pending action excludes duplicate and other actions; failure permits retry", async () => {
  let rejectAction: ((error: Error) => void) | undefined;
  let calls = 0;
  const view = await screen(
    { ...completion, outputPath: join(tmpdir(), "catalog.json") },
    {
      copy: () =>
        Effect.callback<void, DesktopError>((resume) => {
          calls++;
          rejectAction = (cause) =>
            resume(
              Effect.fail(new DesktopError({ message: cause.message, cause })),
            );
        }),
      openFolder: () =>
        Effect.sync(() => {
          calls++;
        }),
    },
  );

  await view.key("c");
  await view.key("c");
  await view.key("j");
  await view.key("v");
  await view.key("t");
  await view.key("o");

  expect(calls).toBe(1);

  rejectAction?.(new Error("clipboard unavailable"));
  await tick();

  expect(view.text()).toContain("clipboard unavailable");
  expect(view.text()).toContain("catalog.json");

  await view.key("o");

  expect(calls).toBe(2);

  await view.key("q");

  expect(view.exits).toEqual([0]);
});

for (const format of ["json", "csv", "tsv"] as const) {
  test(`${format} completion copies selected bytes and every format without changing selection`, async () => {
    const result: Completion = {
      ...completion,
      format,
      pretty: true,
      output: serializeCatalog(completion.catalog, { format, pretty: true }),
    };
    const view = await screen(result);

    expect(view.text()).toContain(`c copy ${format.toUpperCase()}`);
    expect(view.text()).toContain(`${format.toUpperCase()} written to stdout`);

    for (const [key, requested] of [
      ["j", "json"],
      ["v", "csv"],
      ["t", "tsv"],
    ] as const) {
      const hint = `${key} copy ${requested.toUpperCase()}`;

      if (requested === format) expect(view.text()).not.toContain(hint);
      else expect(view.text()).toContain(hint);

      await view.key(key);

      expect(view.copies.at(-1)).toBe(
        requested === format
          ? result.output
          : serializeCatalog(result.catalog, {
              format: requested,
              pretty: true,
            }),
      );
      expect(view.text()).toContain(`${requested.toUpperCase()} copied`);
    }

    await view.key("c");
    await view.key("c");

    expect(view.copies.slice(-2)).toEqual([result.output, result.output]);

    view.output.columns = 24;
    view.output.emit("resize");
    await tick();

    expect(view.text()).toContain(`copy ${format.toUpperCase()}`);

    await view.key("p");
    await view.key("o");

    expect(view.copies).toHaveLength(5);
    expect(view.folders).toEqual([]);
  });
}

test("alternate copy failure stays local and allows another format", async () => {
  const copies: string[] = [];
  const view = await screen(
    { ...completion, format: "csv" },
    {
      copy: (text) =>
        Effect.gen(function* () {
          copies.push(text);

          if (copies.length === 1)
            yield* Effect.fail(
              new DesktopError({
                message: "clipboard unavailable",
                cause: undefined,
              }),
            );
        }),
      openFolder: () => Effect.void,
    },
  );

  await view.key("t");

  expect(view.text()).toContain("Action failed: clipboard unavailable");
  expect(view.text()).toContain("CSV remains in terminal output.");
  expect(view.exits).toEqual([]);

  await view.key("j");

  expect(view.text()).toContain("JSON copied");
  expect(copies).toEqual([
    serializeCatalog(completion.catalog, { format: "tsv" }),
    serializeCatalog(completion.catalog, { format: "json" }),
  ]);
});

test("unmount interrupts an outstanding desktop action", async () => {
  let interrupted = false;
  let started = false;
  const view = await screen(completion, {
    copy: () =>
      Effect.callback<void>(() => {
        started = true;

        return Effect.sync(() => {
          interrupted = true;
        });
      }),
    openFolder: () => Effect.void,
  });

  await view.key("c");

  expect(started).toBe(true);

  view.instance.unmount();
  await tick();

  expect(interrupted).toBe(true);
  expect(view.text()).not.toContain("JSON copied");
});

for (const exit of ["close", "stop"] as const) {
  test(`${exit} waits for outstanding desktop finalizers`, async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      setRawMode(value: boolean): void;
      ref(): void;
      unref(): void;
    };

    input.isTTY = true;
    input.setRawMode = () => {};
    input.ref = () => {};
    input.unref = () => {};

    const output = new PassThrough() as PassThrough & {
      columns: number;
      rows: number;
      isTTY: boolean;
    };

    output.columns = 80;
    output.rows = 30;
    output.isTTY = true;
    output.resume();

    let release: (() => void) | undefined;
    let started = false;
    let finalized = false;
    const ui = createTerminalUI({
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      onCancel() {},
      desktop: {
        copy: () =>
          Effect.gen(function* () {
            started = true;
            yield* Effect.never;
          }).pipe(
            Effect.ensuring(
              Effect.callback<void>((resume) => {
                release = () => {
                  finalized = true;
                  resume(Effect.void);
                };
              }),
            ),
          ),
        openFolder: () => Effect.void,
      },
    });
    let completed = false;
    const completionResult = Effect.runPromise(ui.complete(completion)).then(
      (code) => {
        completed = true;

        return code;
      },
    );

    await tick();
    input.write("c");
    await tick();

    expect(started).toBe(true);

    if (exit === "close") input.write("q");

    let stopped = false;

    await tick();

    const stopResult = Effect.runPromise(ui.stop()).then(() => {
      stopped = true;
    });

    await tick();

    expect(release).toBeDefined();
    expect(completed).toBe(false);
    expect(stopped).toBe(false);
    expect(finalized).toBe(false);

    release?.();

    expect(await completionResult).toBe(exit === "close" ? 0 : 130);

    await stopResult;

    expect(finalized).toBe(true);

    input.destroy();
    output.destroy();
  });
}

function rendererWithExit(waitUntilExit: () => Promise<void>): typeof render {
  return () => ({
    rerender() {},
    unmount() {},
    clear() {},
    cleanup() {},
    waitUntilRenderFlush: () => Promise.resolve(),
    waitUntilExit,
  });
}

test("renderer teardown rejection settles both completion and stop", async () => {
  const failure = new Error("renderer teardown failed");
  const ui = createTerminalUI({
    onCancel() {},
    renderTerminal: rendererWithExit(() => Promise.reject(failure)),
  });
  const completed = Effect.runPromise(Effect.exit(ui.complete(completion)));
  const stopped = await Effect.runPromise(Effect.exit(ui.stop()));
  const result = await completed;

  expect(Exit.isFailure(result)).toBe(true);
  expect(Exit.isFailure(stopped)).toBe(true);

  if (Exit.isFailure(result))
    expect(String(result.cause)).toContain(failure.message);
});

test("stop joins retiring renderer after clear is interrupted", async () => {
  let release: (() => void) | undefined;
  const ui = createTerminalUI({
    onCancel() {},
    renderTerminal: rendererWithExit(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    ),
  });
  const clearing = Effect.runFork(ui.clear());

  await tick();

  expect(release).toBeDefined();

  await Effect.runPromise(Fiber.interrupt(clearing));

  let stopped = false;
  const stopping = Effect.runPromise(ui.stop()).then(() => {
    stopped = true;
  });

  await tick();

  expect(stopped).toBe(false);

  release?.();
  await stopping;

  expect(stopped).toBe(true);
});
