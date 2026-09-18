import { setImmediate as immediate } from "node:timers/promises";
import { Effect, Exit, Fiber } from "effect";
import { Box, render, Text, useInput, useWindowSize } from "ink";
import { useEffect, useRef, useState } from "react";
import { createDesktopActions, type DesktopActions } from "./desktop";
import { serializeCatalog } from "./format";
import type { Completion, OutputFormat, Progress } from "./types";

const copyFormats = { j: "json", v: "csv", t: "tsv" } as const;

interface ViewProps {
  progress: Progress;
  completion?: Completion;
  desktop: DesktopActions;
  onCancel(): void;
  onClose(code: number): void;
  onActionFiber?(fiber: Fiber.Fiber<void>): void;
}

// Exported so offline tests can exercise the same keyboard and rendering path.
export function TerminalView({
  progress,
  completion,
  desktop,
  onCancel,
  onClose,
  onActionFiber,
}: ViewProps) {
  const { columns: width } = useWindowSize();
  const [feedback, setFeedback] = useState("");
  const [inputReady, setInputReady] = useState(false);
  const busy = useRef(false);
  const actionFiber = useRef<Fiber.Fiber<void> | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    return () => {
      mounted.current = false;

      if (actionFiber.current)
        Effect.runFork(Fiber.interrupt(actionFiber.current));
    };
  }, []);

  function action(key: string) {
    if (!completion || busy.current) return;

    if ((key === "p" || key === "o") && !completion.outputPath) return;

    busy.current = true;
    setFeedback(key === "o" ? "Opening folder…" : "Copying…");

    const format: OutputFormat | undefined =
      key === "c"
        ? completion.format
        : copyFormats[key as keyof typeof copyFormats];

    actionFiber.current = Effect.runFork(
      Effect.gen(function* () {
        if (format) {
          const output =
            format === completion.format
              ? completion.output
              : serializeCatalog(completion.catalog, {
                  format,
                  pretty: completion.pretty,
                });

          yield* desktop.copy(output);
        } else if (completion.outputPath) {
          if (key === "p") yield* desktop.copy(completion.outputPath);
          else yield* desktop.openFolder(completion.outputPath);
        }

        if (mounted.current) {
          setFeedback(
            format
              ? `${format.toUpperCase()} copied`
              : key === "p"
                ? "Path copied"
                : "Folder open requested",
          );
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            if (mounted.current)
              setFeedback(
                `Action failed: ${error.message}. ${completion.outputPath ? `File: ${completion.outputPath}` : `${completion.format.toUpperCase()} remains in terminal output.`}`,
              );
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            busy.current = false;
          }),
        ),
      ),
    );
    onActionFiber?.(actionFiber.current);
  }

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (completion) onClose(130);
      else onCancel();

      return;
    }

    if (!completion) return;

    if (input === "q" || key.return) onClose(0);
    else if (
      input === "c" ||
      input === "j" ||
      input === "v" ||
      input === "t" ||
      input === "p" ||
      input === "o"
    )
      action(input);
  });

  // Show actionable controls only after useInput has installed its listeners.
  useEffect(() => setInputReady(true), []);

  if (!inputReady) return null;

  return (
    <Box flexDirection="column" width={Math.max(1, width)}>
      {completion ? (
        <CompletionView
          completion={completion}
          width={width}
          feedback={feedback}
        />
      ) : (
        <RunningView progress={progress} />
      )}
    </Box>
  );
}

function RunningView({ progress }: { progress: Progress }) {
  return (
    <>
      <Text bold color="cyan">
        {progress.phase === "discovering"
          ? "Discovering catalog"
          : "Reading products"}
      </Text>
      <Text>
        {progress.processedProducts} read · {progress.discoveredProducts} found
        · {progress.pages} pages
      </Text>
      <Text dimColor>
        {progress.queued} queued · {progress.active} active
        {progress.retries > 0 ? ` · ${progress.retries} retries` : ""}
      </Text>
      <Box marginTop={1}>
        <Text dimColor>Ctrl+C cancel</Text>
      </Box>
    </>
  );
}

function CompletionView({
  completion,
  width,
  feedback,
}: {
  completion: Completion;
  width: number;
  feedback: string;
}) {
  return (
    <>
      <Text bold color="cyan">
        Catalog complete
      </Text>
      <Text>
        {completion.productCount} products · {completion.catalog.results.length}{" "}
        results
      </Text>
      <Text>
        Total ${completion.catalog.total.toFixed(2)} ·{" "}
        {(completion.elapsedMs / 1000).toFixed(1)}s
      </Text>
      <Text wrap="wrap">
        {completion.outputPath
          ? `Saved ${completion.outputPath}`
          : `${completion.format.toUpperCase()} written to stdout`}
      </Text>
      <Box
        marginTop={1}
        flexDirection={width < 55 ? "column" : "row"}
        flexWrap="wrap"
        gap={width < 55 ? 0 : 2}
      >
        <Text>
          <Text color="cyan">c</Text> copy {completion.format.toUpperCase()}
        </Text>
        {Object.entries(copyFormats)
          .filter(([, format]) => format !== completion.format)
          .map(([key, format]) => (
            <Text key={key}>
              <Text color="cyan">{key}</Text> copy {format.toUpperCase()}
            </Text>
          ))}
        {completion.outputPath && (
          <Text>
            <Text color="cyan">p</Text> copy path
          </Text>
        )}
        {completion.outputPath && (
          <Text>
            <Text color="cyan">o</Text> open folder
          </Text>
        )}
        <Text>
          <Text color="cyan">q / Enter</Text> close
        </Text>
      </Box>
      {feedback && <Text wrap="wrap">{feedback}</Text>}
    </>
  );
}

export function createTerminalUI({
  onCancel,
  desktop = createDesktopActions(),
  stdin = process.stdin,
  stdout = process.stderr,
  renderTerminal = render,
}: {
  onCancel(): void;
  desktop?: DesktopActions;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  renderTerminal?: typeof render;
}) {
  let progress: Progress = {
    phase: "discovering",
    pages: 0,
    discoveredProducts: 0,
    processedProducts: 0,
    queued: 0,
    active: 0,
    retries: 0,
  };
  let completion: Completion | undefined;
  let stopped = false;
  let finish: ((result: Effect.Effect<number>) => void) | undefined;
  let retiring: Fiber.Fiber<void> | undefined;
  let actionFiber: Fiber.Fiber<void> | undefined;
  let closing: Fiber.Fiber<void> | undefined;

  const close = (code: number): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!closing) {
        stopped = true;
        closing = Effect.runFork(
          Effect.uninterruptible(
            Effect.gen(function* () {
              // Join interruption so delayed action finalizers finish before CLI exit.
              if (actionFiber) yield* Fiber.interrupt(actionFiber);
              if (retiring) yield* Fiber.join(retiring);

              const previous = instance;
              instance = undefined;
              previous?.unmount();

              if (previous)
                yield* Effect.promise(() => previous.waitUntilExit());
            }).pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  finish?.(
                    Exit.isSuccess(exit)
                      ? Effect.succeed(code)
                      : Effect.failCause(exit.cause),
                  );
                }),
              ),
            ),
          ),
        );
      }

      return Fiber.join(closing);
    });

  const view = () => (
    <TerminalView
      progress={progress}
      {...(completion ? { completion } : {})}
      desktop={desktop}
      onCancel={onCancel}
      onClose={(code) => {
        Effect.runFork(close(code));
      }}
      onActionFiber={(fiber) => {
        actionFiber = fiber;
      }}
    />
  );

  const mount = () =>
    renderTerminal(view(), {
      stdout,
      stderr: stdout,
      stdin,
      patchConsole: false,
      exitOnCtrlC: false,
      maxFps: 10,
      interactive: true,
    });

  let instance: ReturnType<typeof render> | undefined = mount();

  return {
    update(next: Progress) {
      if (stopped || completion) return;

      progress = next;
      instance?.rerender(view());
    },
    complete(result: Completion): Effect.Effect<number> {
      return Effect.callback<number>((resume) => {
        if (stopped) {
          resume(close(130).pipe(Effect.as(130)));

          return;
        }

        completion = result;
        finish = resume;

        if (instance) instance.rerender(view());
        else instance = mount();

        return close(130);
      });
    },
    clear(): Effect.Effect<void> {
      return Effect.gen(function* () {
        if (stopped || !instance) return;

        const flushing = instance;
        yield* Effect.promise(() => flushing.waitUntilRenderFlush());

        if (stopped || !instance) return;

        // Ink clear() retains redraw height. Unmount before a direct stdout write
        // so the completion renderer cannot erase the result from the terminal.
        const previous = instance;
        instance = undefined;
        retiring = Effect.runFork(
          Effect.uninterruptible(
            Effect.gen(function* () {
              previous.clear();
              previous.unmount();
              yield* Effect.promise(() => previous.waitUntilExit());

              // Ink defers input cleanup. Let its passive effects and raw-mode teardown
              // finish before a new renderer starts owning this same terminal.
              yield* Effect.promise(() => immediate());
            }),
          ),
        );
        yield* Fiber.join(retiring);
      });
    },
    stop(): Effect.Effect<void> {
      return close(130);
    },
  };
}
