import { basename } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Cause, Console, Data, Effect, Option } from "effect";
import {
  CliConfig,
  CliOutput,
  Command,
  Flag,
  GlobalFlag,
} from "effect/unstable/cli";
import { crawl } from "./crawl";
import { serializeCatalog } from "./format";
import { writeResult, writeStream } from "./output";
import type { OutputFormat } from "./types";

// Replaced by the standalone build; source execution keeps Bun instructions.
declare const NATTER_STANDALONE: boolean;

const invocation =
  typeof NATTER_STANDALONE !== "undefined" && NATTER_STANDALONE
    ? `${process.platform === "win32" ? ".\\" : "./"}${basename(process.execPath)}`
    : "bun run scrape";

export function shouldInteract(options: {
  interactive: boolean;
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
  stderrTTY?: boolean;
  ci?: string;
}): boolean {
  const ci = options.ci?.toLowerCase();

  return Boolean(
    options.interactive &&
      options.stdinTTY &&
      options.stdoutTTY &&
      options.stderrTTY &&
      (!ci || ci === "0" || ci === "false"),
  );
}

class UsageError extends Data.TaggedError("UsageError")<{
  readonly message: string;
}> {}

interface Options {
  output: Option.Option<string>;
  format: OutputFormat;
  pretty: boolean;
  interactive: boolean;
}

const helpNotes = `
OUTPUT
  Selected output goes to stdout or --output. Progress and errors go to stderr.
  JSON includes results and total. CSV/TSV have name,description,price,colors columns.
  A failed run emits no partial catalog. --pretty applies only to JSON.

TERMINAL
  Interaction starts automatically when all three streams are terminals.
  --no-interactive disables progress and hotkeys. Pipes/redirection/CI never wait.

  Copy:  c selected format    j JSON    v CSV    t TSV
  File:  p copy saved path    o open folder
  Exit:  q / Enter close     Ctrl+C cancel

LIMITS
  2 concurrent requests, 15s per request, 5min per run, 2 retries.
  Exit codes: 0 success/help, 1 scrape/write failure, 2 usage, 130 Ctrl+C.
  On macOS/Linux, SIGTERM exits 143. Windows forced termination cannot run cleanup.
`;

function scrape(
  options: Options,
  dependencies: { crawl?: typeof crawl },
  cancel: () => void,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const outputPath = Option.getOrUndefined(options.output);

      if (outputPath !== undefined && !outputPath.trim())
        return yield* new UsageError({
          message: "Output path must not be empty.",
        });

      if (options.pretty && options.format !== "json")
        return yield* new UsageError({
          message: "--pretty is only supported with --format json",
        });

      const interactive = shouldInteract({
        interactive: options.interactive,
        stdinTTY: Boolean(process.stdin.isTTY),
        stdoutTTY: Boolean(process.stdout.isTTY),
        stderrTTY: Boolean(process.stderr.isTTY),
        ...(process.env.CI !== undefined ? { ci: process.env.CI } : {}),
      });
      const started = performance.now();
      const ui = interactive
        ? yield* Effect.acquireRelease(
            Effect.gen(function* () {
              const { createTerminalUI } = yield* Effect.promise(
                () => import("./ui"),
              );

              return createTerminalUI({ onCancel: cancel });
            }),
            (view) => view.stop(),
          )
        : undefined;

      if (!ui)
        yield* writeStream(process.stderr, "Reading the static catalog…\n");

      const result = yield* (dependencies.crawl ?? crawl)({
        onProgress: (progress) => ui?.update(progress),
      });

      const output = serializeCatalog(result.catalog, {
        format: options.format,
        pretty: options.pretty,
      });

      if (ui) yield* ui.clear();

      const savedPath = yield* writeResult(
        output,
        outputPath === undefined ? {} : { path: outputPath },
      );

      if (ui)
        return yield* ui.complete({
          catalog: result.catalog,
          output,
          format: options.format,
          pretty: options.pretty,
          ...(savedPath ? { outputPath: savedPath } : {}),
          productCount: result.productCount,
          elapsedMs: performance.now() - started,
        });

      yield* writeStream(
        process.stderr,
        `Completed: ${result.productCount} products, ${result.catalog.results.length} results, $${result.catalog.total.toFixed(2)}${savedPath ? `; saved ${savedPath}` : ""}.\n`,
      );

      return 0;
    }),
  );
}

/** The application is an Effect; only executable entry points run the runtime. */
export function runCli(
  argv: string[],
  dependencies: { crawl?: typeof crawl } = {},
): Effect.Effect<number> {
  return Effect.suspend(() => {
    let completionCode = 0;
    let cancel = () => {};
    const messages: string[] = [];

    // Effect CLI renders help for usage errors too. Buffer it so errors never
    // contaminate the data stream, while explicit --help still uses stdout.
    const cliConsole: Console.Console = Object.assign(Object.create(console), {
      log: (...values: ReadonlyArray<unknown>) => {
        messages.push(values.map(String).join(" "));
      },
      error: (...values: ReadonlyArray<unknown>) => {
        messages.push(values.map(String).join(" "));
      },
    });
    const formatter = CliOutput.defaultFormatter({ colors: false });

    const command = Command.make(
      "natter-scraper",
      {
        output: Flag.String("output").pipe(
          Flag.withAlias("o"),
          Flag.withDescription(
            "Save completed output to a file; omitted or '-' means stdout",
          ),
          Flag.optional,
        ),
        format: Flag.Literals("format", ["json", "csv", "tsv"]).pipe(
          Flag.withAlias("f"),
          Flag.withDescription("Output format; independent of filename"),
          Flag.withDefault("json"),
        ),
        pretty: Flag.Boolean("pretty").pipe(
          Flag.withDescription("Indent JSON output"),
          Flag.withDefault(false),
        ),
        interactive: Flag.Boolean("interactive").pipe(
          Flag.withDescription(
            "Terminal progress and hotkeys; disable with --no-interactive",
          ),
          Flag.withDefault(true),
        ),
      },
      (options) =>
        Effect.gen(function* () {
          completionCode = yield* scrape(options, dependencies, () => cancel());
        }),
    ).pipe(
      Command.withDescription(
        "Extract every reachable product and enabled storage configuration from the Web Scraper static test catalog.",
      ),
      Command.withExamples([
        {
          command: `${invocation} --output products.json --pretty`,
          description: "Save readable JSON",
        },
        {
          command: `${invocation} --format csv --output products.csv`,
          description: "Save spreadsheet rows",
        },
        {
          command: `${invocation} --format tsv --no-interactive > products.tsv`,
          description: "Export tab-separated rows",
        },
        {
          command: `${invocation} | jq '.total'`,
          description: "Pipe JSON into another command",
        },
      ]),
    );

    const application = Command.runWith(command, {
      version: "0.1.0",
      renderErrors: false,
    })(argv).pipe(
      Effect.provideService(Console.Console, cliConsole),
      Effect.provideService(CliOutput.Formatter, {
        ...formatter,
        formatHelpDoc: (doc) => `${formatter.formatHelpDoc(doc)}\n${helpNotes}`,
      }),
      Effect.provideService(
        CliConfig.CliConfig,
        CliConfig.make({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] }),
      ),
      Effect.provide(BunServices.layer),
      Effect.map(() => completionCode),
      Effect.catchTag("ShowHelp", (error) =>
        error.errors.length
          ? writeStream(
              process.stderr,
              `error: ${error.errors.map((item) => item.message).join("; ")}\n\n`,
            ).pipe(Effect.as(2))
          : Effect.succeed(0),
      ),
      Effect.catchTag("UsageError", (error) =>
        writeStream(
          process.stderr,
          `error: ${error.message}\nUse --help for usage.\n`,
        ).pipe(Effect.as(2)),
      ),
      Effect.tap((code) =>
        messages.length
          ? writeStream(
              code === 2 ? process.stderr : process.stdout,
              `${messages.join("\n")}\n`,
            )
          : Effect.void,
      ),
    );

    const signals = Effect.callback<number>((resume) => {
      const interrupt = () => resume(Effect.succeed(130));
      const terminate = () => resume(Effect.succeed(143));

      cancel = interrupt;
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", terminate);

      return Effect.sync(() => {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);
      });
    });

    return Effect.raceFirst(signals, application).pipe(
      Effect.tap((code) =>
        code === 130 || code === 143
          ? writeStream(
              process.stderr,
              `Cancelled: ${code === 130 ? "Ctrl+C" : "SIGTERM"}\n`,
            ).pipe(Effect.ignore)
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        writeStream(process.stderr, `Error: ${Cause.pretty(cause)}\n`).pipe(
          Effect.ignore,
          Effect.as(1),
        ),
      ),
    );
  });
}

/** Called only after the application scope has restored terminal and I/O state. */
export function finishCli(code: number): void {
  process.exitCode = code;

  // Bun can retain a blocked native stdout flush after destroy(). Cancellation
  // exits after Effect finalization; successful writes finish naturally.
  if (code === 130 || code === 143) process.exit(code);
}

if (import.meta.main)
  finishCli(await Effect.runPromise(runCli(process.argv.slice(2))));
