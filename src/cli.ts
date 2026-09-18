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
import { resolveOutputFormat } from "./output-format";
import type { OutputFormat } from "./types";

// Replaced by the standalone build; source execution keeps Bun instructions.
declare const NATTER_STANDALONE: boolean;

const invocation =
  typeof NATTER_STANDALONE !== "undefined" && NATTER_STANDALONE
    ? `${process.platform === "win32" ? ".\\" : "./"}${basename(process.execPath)}`
    : "bun run scrape";

export function shouldInteract(options: {
  interactive: boolean | undefined;
  outputPath?: string;
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
  stderrTTY?: boolean;
  ci?: string;
  term?: string;
}): boolean {
  const ci = options.ci?.toLowerCase();

  return Boolean(
    (options.interactive ?? options.outputPath === undefined) &&
      options.outputPath !== "-" &&
      options.stdinTTY &&
      options.stdoutTTY &&
      options.stderrTTY &&
      options.term?.toLowerCase() !== "dumb" &&
      (!ci || ci === "0" || ci === "false"),
  );
}

class UsageError extends Data.TaggedError("UsageError")<{
  readonly message: string;
}> {}

interface Options {
  concurrency: string;
  output: Option.Option<string>;
  format: OutputFormat | "auto";
  pretty: Option.Option<boolean>;
  interactive: Option.Option<boolean>;
}

const helpNotes = `
OUTPUT
  In a terminal, browse the completed catalog without an automatic export.
  --output FILE saves and exits; add -i / --interactive to browse afterward.
  --output - always prints and exits.
  Pipes, CI, TERM=dumb, and --no-interactive export to stdout or --output.
  --format auto infers .json/.csv/.tsv from FILE; other extensions are rejected.
  Without FILE, or with --output -, auto selects JSON.
  An explicit --format json/csv/tsv overrides the filename extension.
  JSON includes results and total. CSV/TSV have name,description,price,colors columns.
  A failed run emits no partial catalog. Progress and errors go to stderr.
  --pretty indents JSON exports and is rejected for CSV/TSV.
  --no-pretty keeps JSON compact.
  JSON starts pretty in the browser and compact in exports unless overridden.

TERMINAL
  With no --output, interaction starts when all three streams are terminals.
  -i / --interactive enables browsing after --output FILE; --no-interactive disables it.
  Pipes/redirection/CI, TERM=dumb, and --no-interactive never wait for keys.

  View:  Tab table/JSON    arrows / Page Up/Down / Home/End navigate
         d/u or Ctrl+d/u half page    Space/b full page down/up
         g/G first/last    Enter details
         [ - previous product    ] - next product in details
         r pretty/compact in JSON    ? help/back
  Copy:  c choose format    j JSON    v CSV    t TSV
  Save:  s save (Tab/Shift+Tab: auto, CSV, TSV, JSON compact, JSON pretty)
  File:  p copy saved path    o open folder    f open file
  Exit:  q close    Esc back    Ctrl+C cancel

LIMITS
  --concurrency defaults to 2 product slots and concurrent document requests.
  Browser resource requests can exceed this count; higher values use more memory
  and increase load on the source site.
  15s per request/browser operation, 10min per run, 2 HTTP retries.
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
      const concurrency = Number(options.concurrency);

      if (
        !options.concurrency ||
        /[^0-9]/.test(options.concurrency) ||
        !Number.isSafeInteger(concurrency) ||
        concurrency < 1
      )
        return yield* new UsageError({
          message:
            "--concurrency must be a positive safe integer in decimal digits.",
        });

      const outputPath = Option.getOrUndefined(options.output);

      if (outputPath !== undefined && !outputPath.trim())
        return yield* new UsageError({
          message: "Output path must not be empty.",
        });

      const format = yield* resolveOutputFormat(
        options.format,
        outputPath,
      ).pipe(
        Effect.mapError((error) => new UsageError({ message: error.message })),
      );
      const requestedPretty = Option.getOrUndefined(options.pretty);

      if (requestedPretty === true && format !== "json")
        return yield* new UsageError({
          message: "--pretty is only supported with JSON output",
        });

      const interactive = shouldInteract({
        interactive: Option.getOrUndefined(options.interactive),
        ...(outputPath !== undefined ? { outputPath } : {}),
        stdinTTY: Boolean(process.stdin.isTTY),
        stdoutTTY: Boolean(process.stdout.isTTY),
        stderrTTY: Boolean(process.stderr.isTTY),
        ...(process.env.CI !== undefined ? { ci: process.env.CI } : {}),
        ...(process.env.TERM !== undefined ? { term: process.env.TERM } : {}),
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
        concurrency,
        onProgress: (progress) => ui?.update(progress),
      });

      const savedPath =
        !ui || outputPath !== undefined
          ? yield* writeResult(
              serializeCatalog(result.catalog, {
                format,
                pretty: requestedPretty ?? false,
              }),
              outputPath === undefined ? {} : { path: outputPath },
            )
          : undefined;

      if (ui)
        return yield* ui.complete({
          catalog: result.catalog,
          format,
          pretty: requestedPretty ?? true,
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
        concurrency: Flag.String("concurrency").pipe(
          Flag.withDescription(
            "Maximum concurrent products and document requests; positive integer (higher uses more memory and source capacity)",
          ),
          Flag.withDefault("2"),
        ),
        output: Flag.String("output").pipe(
          Flag.withAlias("o"),
          Flag.withDescription(
            "Save and exit; add -i to browse afterward; '-' prints to stdout",
          ),
          Flag.optional,
        ),
        format: Flag.Literals("format", ["auto", "json", "csv", "tsv"]).pipe(
          Flag.withAlias("f"),
          Flag.withDescription(
            "Infer from output filename (auto), or choose an explicit format",
          ),
          Flag.withDefault("auto"),
        ),
        pretty: Flag.Boolean("pretty").pipe(
          Flag.withDescription(
            "Indent JSON; --no-pretty selects compact JSON (browser default: pretty; export default: compact)",
          ),
          Flag.optional,
        ),
        interactive: Flag.Boolean("interactive").pipe(
          Flag.withAlias("i"),
          Flag.withDescription(
            "Terminal browser (default: on without --output, off with it); --no-interactive disables",
          ),
          Flag.optional,
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
          command: `${invocation} -o products.json -i`,
          description: "Save JSON, then browse the catalog",
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
