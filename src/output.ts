import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { Data, Effect } from "effect";

export class OutputError extends Data.TaggedError("OutputError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const streamError = (cause: unknown) =>
  new OutputError({
    message: `Could not write output: ${cause instanceof Error ? cause.message : String(cause)}`,
    cause,
  });

export function writeStream(
  stream: Writable,
  text: string,
): Effect.Effect<void, OutputError> {
  return Effect.callback<void, OutputError>((resume) => {
    let settled = false;

    const cleanup = () => {
      stream.off("error", fail);
      stream.off("close", closed);
    };

    const fail = (cause: unknown) => {
      cleanup();

      if (settled) return;

      settled = true;
      resume(Effect.fail(streamError(cause)));
    };

    const closed = () => {
      fail(new Error("Output stream closed before the write completed"));
    };

    stream.once("error", fail);
    stream.once("close", closed);

    // The write callback runs only once this chunk has passed through the
    // Writable, including when write() reports backpressure.
    try {
      stream.write(text, (error) => {
        if (settled) return;

        settled = true;

        if (error) {
          // Node emits error after invoking the write callback. Keep the
          // listener until that event (or close) so it is never unhandled.
          resume(Effect.fail(streamError(error)));
        } else {
          cleanup();
          resume(Effect.void);
        }
      });
    } catch (cause) {
      fail(cause);
    }

    return Effect.sync(() => {
      if (settled) return;

      settled = true;

      // Retain error/close listeners until destruction completes.
      stream.destroy();
    });
  });
}

/** Return the saved absolute path, or undefined when writing stdout. */
export function writeResult(
  document: string,
  options: { path?: string; stdout?: Writable } = {},
): Effect.Effect<string | undefined, OutputError> {
  const path = options.path;

  if (!path || path === "-") {
    return writeStream(options.stdout ?? process.stdout, document).pipe(
      Effect.as(undefined),
    );
  }

  return Effect.suspend(() => {
    const destination = resolve(path);
    const temporary = join(
      dirname(destination),
      `.${basename(destination)}.${randomUUID()}.tmp`,
    );

    const fileError = (cause: unknown) =>
      new OutputError({
        message: `Could not save ${destination}: ${cause instanceof Error ? cause.message : String(cause)}. Check the parent directory and write permissions.`,
        cause,
      });

    let owned = false;
    const write = Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => fs.open(temporary, "wx", 0o600),
        catch: fileError,
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            owned = true;
          }),
        ),
      ),
      (file) =>
        Effect.tryPromise({
          try: (signal) =>
            file.writeFile(document, { encoding: "utf8", signal }),
          catch: fileError,
        }),
      (file) =>
        Effect.tryPromise({
          try: () => file.close(),
          catch: fileError,
        }),
    );

    return write.pipe(
      Effect.andThen(
        Effect.tryPromise({
          try: () => fs.rename(temporary, destination),
          catch: fileError,
        }).pipe(Effect.uninterruptible),
      ),
      Effect.as(destination),
      Effect.onExit(() =>
        owned
          ? Effect.tryPromise({
              try: () => fs.unlink(temporary),
              catch: (cause) => cause as NodeJS.ErrnoException,
            }).pipe(
              Effect.catch((cause) =>
                cause.code === "ENOENT"
                  ? Effect.void
                  : Effect.fail(fileError(cause)),
              ),
            )
          : Effect.void,
      ),
    );
  });
}
