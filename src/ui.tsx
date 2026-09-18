import { Effect, Exit, Fiber } from "effect";
import { Box, render, Text, useInput, useWindowSize } from "ink";
import { useEffect, useState } from "react";
import { ResultBrowser } from "./browser";
import { createDesktopActions, type DesktopActions } from "./desktop";
import { type writeResult, writeStream } from "./output";
import { fitText, safeText } from "./terminal-text";
import type { Completion, Progress } from "./types";

interface ViewProps {
  progress: Progress;
  completion?: Completion;
  desktop: DesktopActions;
  saveOutput?: typeof writeResult;
  onCancel(): void;
  onClose(code: number): void;
  onSaved?(path: string): void;
  onActionFiber?(fiber: Fiber.Fiber<void>): void;
}

// Exported so offline tests exercise the same input and rendering path.
export function TerminalView(props: ViewProps) {
  const { columns, rows } = useWindowSize();
  const [ready, setReady] = useState(false);
  const width = Math.max(1, columns);
  const height = Math.max(1, rows - 1);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") props.onCancel();
    },
    { isActive: !props.completion },
  );
  useEffect(() => setReady(true), []);

  if (!ready) return null;

  if (props.completion)
    return (
      <ResultBrowser
        {...props}
        completion={props.completion}
        width={width}
        height={height}
      />
    );

  const progress = props.progress;
  const lines = [
    progress.phase === "discovering"
      ? "Discovering catalog"
      : "Reading products",
    " ",
    progress.processedProducts +
      " read · " +
      progress.discoveredProducts +
      " found · " +
      progress.pages +
      " pages",
    progress.queued +
      " queued · " +
      progress.active +
      " active" +
      (progress.retries ? ` · ${progress.retries} retries` : ""),
    "",
    "Ctrl+C - Cancel",
  ];
  const visible =
    height < lines.length
      ? [lines[0] ?? "", "Ctrl+C - Cancel"].slice(-height)
      : lines;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      paddingX={width > 4 ? 1 : 0}
    >
      {visible.map((line, index) => (
        <Text
          key={line}
          bold={index === 0}
          {...(index === 0 ? { color: "cyan" as const } : {})}
        >
          {fitText(line, width > 4 ? width - 2 : width) || " "}
        </Text>
      ))}
    </Box>
  );
}

export function createTerminalUI({
  onCancel,
  desktop = createDesktopActions(),
  saveOutput,
  stdin = process.stdin,
  stdout = process.stderr,
  renderTerminal = render,
}: {
  onCancel(): void;
  desktop?: DesktopActions;
  saveOutput?: typeof writeResult;
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
  let savedPath: string | undefined;
  let stopped = false;
  let finish: ((result: Effect.Effect<number>) => void) | undefined;
  let actionFiber: Fiber.Fiber<void> | undefined;
  let closing: Fiber.Fiber<void> | undefined;

  const close = (code: number): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!closing) {
        stopped = true;
        closing = Effect.runFork(
          Effect.uninterruptible(
            Effect.gen(function* () {
              // Join action finalizers before restoring the terminal and resolving.
              if (actionFiber) yield* Fiber.interrupt(actionFiber);

              const previous = instance;
              instance = undefined;
              previous?.unmount();

              if (previous)
                yield* Effect.promise(() => previous.waitUntilExit());

              // Alternate-screen output is discarded. Write the lasting summary only
              // after Ink has restored the previous screen and released raw input.
              if (completion && code === 0)
                yield* writeStream(
                  stdout,
                  "Completed: " +
                    completion.productCount +
                    " products, " +
                    completion.catalog.results.length +
                    " results, $" +
                    completion.catalog.total.toFixed(2) +
                    (savedPath
                      ? `; saved ${safeText(savedPath).replace(/\n/gu, " ")}`
                      : "; no file saved") +
                    ".\n",
                ).pipe(Effect.orDie);
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
      {...(saveOutput ? { saveOutput } : {})}
      desktop={desktop}
      onCancel={onCancel}
      onClose={(code) => {
        Effect.runFork(close(code));
      }}
      onSaved={(path) => {
        savedPath = path;
      }}
      onActionFiber={(fiber) => {
        actionFiber = fiber;
      }}
    />
  );
  let instance: ReturnType<typeof render> | undefined = renderTerminal(view(), {
    stdout,
    stderr: stdout,
    stdin,
    patchConsole: false,
    exitOnCtrlC: false,
    maxFps: 10,
    interactive: true,
    alternateScreen: true,
  });

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
        savedPath = result.outputPath;
        finish = resume;
        instance?.rerender(view());

        return close(130);
      });
    },
    stop(): Effect.Effect<void> {
      return close(130);
    },
  };
}
