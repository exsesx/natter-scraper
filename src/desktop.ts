import { dirname } from "node:path";
import { Data, Effect } from "effect";

export class DesktopError extends Data.TaggedError("DesktopError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export interface DesktopActions {
  copy(text: string): Effect.Effect<void, DesktopError>;
  openFile(filePath: string): Effect.Effect<void, DesktopError>;
  openFolder(filePath: string): Effect.Effect<void, DesktopError>;
}

const desktopError = (cause: unknown) =>
  new DesktopError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

// Paths remain arguments to the desktop helper, never shell command strings.
export function createDesktopActions(
  writeClipboard: (text: string) => Promise<void> = async (text) => {
    const { default: clipboard } = await import("clipboardy");

    await clipboard.write(text);
  },
  openPath: (path: string) => Promise<unknown> = async (path) => {
    const { default: open } = await import("open");

    return open(path, { wait: false });
  },
): DesktopActions {
  return {
    copy: (text) =>
      Effect.tryPromise({
        try: () => writeClipboard(text),
        catch: desktopError,
      }),
    openFile: (filePath) =>
      Effect.tryPromise({
        try: () => openPath(filePath),
        catch: desktopError,
      }).pipe(Effect.asVoid),
    openFolder: (filePath) =>
      Effect.tryPromise({
        try: () => openPath(dirname(filePath)),
        catch: desktopError,
      }).pipe(Effect.asVoid),
  };
}
