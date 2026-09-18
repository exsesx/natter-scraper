import { resolve } from "node:path";
import { Effect, Fiber } from "effect";
import { useEffect, useRef, useState } from "react";
import { type Dialog, formats, type SaveDialog } from "./browser-dialogs";
import type { DesktopActions } from "./desktop";
import { serializeCatalog } from "./format";
import { OutputError, writeResult } from "./output";
import { resolveOutputFormat } from "./output-format";
import type { Completion, OutputFormat } from "./types";

interface ActionOptions {
  completion: Completion;
  pretty: boolean;
  onPrettyChange(pretty: boolean): void;
  desktop: DesktopActions;
  saveOutput?: typeof writeResult;
  onSaved?(path: string): void;
  onActionFiber?(fiber: Fiber.Fiber<void>): void;
}

/** Serializes user-requested exports and keeps their cleanup tied to the browser. */
export function useBrowserActions({
  completion,
  pretty,
  onPrettyChange,
  desktop,
  saveOutput = writeResult,
  onSaved,
  onActionFiber,
}: ActionOptions) {
  const [exportFormat, setExportFormat] = useState(completion.format);
  const [savedPath, setSavedPath] = useState(completion.outputPath);
  const [dialog, setDialog] = useState<Dialog>();
  const [feedback, setFeedback] = useState("");
  const [working, setWorking] = useState(false);
  const busy = useRef(false);
  const actionFiber = useRef<Fiber.Fiber<void> | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;

      if (actionFiber.current)
        Effect.runFork(Fiber.interrupt(actionFiber.current));
    };
  }, []);

  function report(message: string) {
    if (mounted.current) setFeedback(message);
  }

  function runAction(
    action: Effect.Effect<void, { message: string }>,
    label: string,
  ) {
    if (busy.current) return;

    busy.current = true;
    setWorking(true);
    setFeedback(label);
    actionFiber.current = Effect.runFork(
      action.pipe(
        Effect.catch((error) =>
          Effect.sync(() => report(`Action failed: ${error.message}`)),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            busy.current = false;

            if (mounted.current) setWorking(false);
          }),
        ),
      ),
    );
    onActionFiber?.(actionFiber.current);
  }

  function copy(format: OutputFormat) {
    setExportFormat(format);
    setDialog(undefined);
    runAction(
      desktop
        .copy(serializeCatalog(completion.catalog, { format, pretty }))
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => report(`${format.toUpperCase()} copied`)),
          ),
        ),
      `Copying ${format.toUpperCase()}…`,
    );
  }

  function save(request: SaveDialog, overwrite = false) {
    if (!request.path.trim() || request.path === "-") {
      setFeedback(
        "Enter a file path, such as catalog.json. '-' is reserved for CLI stdout.",
      );

      return;
    }

    runAction(
      Effect.gen(function* () {
        const format = yield* resolveOutputFormat(request.format, request.path);
        const output = serializeCatalog(completion.catalog, {
          format,
          pretty: request.pretty,
        });
        const path = yield* saveOutput(output, {
          path: resolve(request.path),
          overwrite,
        });

        if (!path)
          return yield* new OutputError({ message: "No file was saved." });

        // Retain successful publication even if closing interrupts later UI work.
        onSaved?.(path);

        if (mounted.current) {
          if (format === "json") onPrettyChange(request.pretty);

          setSavedPath(path);
          setExportFormat(format);
          setDialog(undefined);
          setFeedback(`Saved ${path}`);
        }
      }).pipe(
        Effect.catchTag("OutputError", (error) => {
          if (error.code !== "EEXIST" || overwrite) return Effect.fail(error);

          return Effect.sync(() => {
            if (mounted.current) {
              setDialog({ type: "replace", save: request });
              setFeedback("The existing file has not changed.");
            }
          });
        }),
      ),
      "Saving…",
    );
  }

  function fileAction(key: "p" | "f" | "o") {
    if (!savedPath) return;

    const actions = {
      p: {
        effect: () => desktop.copy(savedPath),
        message: "Path copied",
        pending: "Copying path…",
      },
      f: {
        effect: () => desktop.openFile(savedPath),
        message: "File open requested",
        pending: "Opening…",
      },
      o: {
        effect: () => desktop.openFolder(savedPath),
        message: "Folder open requested",
        pending: "Opening…",
      },
    };
    const action = actions[key];

    runAction(
      action
        .effect()
        .pipe(Effect.tap(() => Effect.sync(() => report(action.message)))),
      action.pending,
    );
  }

  function openCopyDialog() {
    setDialog({ type: "copy", selected: formats.indexOf(exportFormat) });
  }

  function openSaveDialog() {
    const path = `catalog.${exportFormat}`;

    setDialog({
      type: "save",
      path,
      cursor: path.length,
      format: "auto",
      pretty,
    });
  }

  function handleShortcut(input: string): boolean {
    switch (input) {
      case "c":
        openCopyDialog();
        break;
      case "s":
        openSaveDialog();
        break;
      case "j":
        copy("json");
        break;
      case "v":
        copy("csv");
        break;
      case "t":
        copy("tsv");
        break;
      case "p":
      case "f":
      case "o":
        fileAction(input);
        break;
      default:
        return false;
    }

    return true;
  }

  return {
    savedPath,
    dialog,
    setDialog,
    feedback,
    working,
    busy,
    copy,
    save,
    handleShortcut,
  };
}
