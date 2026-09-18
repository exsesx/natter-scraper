import { resolve } from "node:path";
import { Box, type Key, Text } from "ink";
import { inferOutputFormat } from "./output-format";
import { fitText, safeText } from "./terminal-text";
import type { OutputFormat } from "./types";

export const formats = ["json", "csv", "tsv"] as const;
const saveFormats = [
  { format: "auto" },
  { format: "csv" },
  { format: "tsv" },
  { format: "json", pretty: false },
  { format: "json", pretty: true },
] as const;

export type SaveDialog = {
  type: "save";
  path: string;
  cursor: number;
  format: OutputFormat | "auto";
  pretty: boolean;
};

export type Dialog =
  | SaveDialog
  | { type: "copy"; selected: number }
  | { type: "replace"; save: SaveDialog };

interface DialogActions {
  setDialog(dialog: Dialog | undefined): void;
  copy(format: OutputFormat): void;
  save(dialog: SaveDialog, overwrite?: boolean): void;
}

function moveCursor(
  key: Key,
  cursor: number,
  length: number,
): number | undefined {
  if (key.home) return 0;

  if (key.end) return length;

  if (key.leftArrow) return Math.max(0, cursor - 1);

  if (key.rightArrow) return Math.min(length, cursor + 1);

  return undefined;
}

function editPath(dialog: SaveDialog, input: string, key: Key): SaveDialog {
  if (key.ctrl && input === "u") return { ...dialog, path: "", cursor: 0 };

  const chars = Array.from(dialog.path);
  const moved = moveCursor(key, dialog.cursor, chars.length);

  if (moved !== undefined) return { ...dialog, cursor: moved };

  const cursor = dialog.cursor;

  if (key.backspace || key.delete) {
    const start = key.backspace ? Math.max(0, cursor - 1) : cursor;

    if (key.delete || cursor > 0) chars.splice(start, 1);

    return { ...dialog, path: chars.join(""), cursor: start };
  }

  if (key.ctrl || key.meta || !input) return dialog;

  // Paste remains text, never a sequence of global shortcuts or submissions.
  const inserted = Array.from(input.replace(/\p{Cc}/gu, ""));

  chars.splice(cursor, 0, ...inserted);

  return { ...dialog, path: chars.join(""), cursor: cursor + inserted.length };
}

function handleCopyInput(
  dialog: Extract<Dialog, { type: "copy" }>,
  key: Key,
  actions: DialogActions,
) {
  if (key.escape) actions.setDialog(undefined);
  else if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
    const delta = key.upArrow || key.leftArrow ? -1 : 1;

    actions.setDialog({
      ...dialog,
      selected: (dialog.selected + delta + formats.length) % formats.length,
    });
  } else if (key.return) actions.copy(formats[dialog.selected] ?? "json");
}

function handleSaveInput(
  dialog: SaveDialog,
  input: string,
  key: Key,
  actions: DialogActions,
) {
  if (key.escape) actions.setDialog(undefined);
  else if (key.return) actions.save(dialog);
  else if (key.tab) {
    const current = saveFormats.findIndex(
      (choice) =>
        choice.format === dialog.format &&
        (!("pretty" in choice) || choice.pretty === dialog.pretty),
    );
    const direction = key.shift ? -1 : 1;
    const next =
      (current + direction + saveFormats.length) % saveFormats.length;

    actions.setDialog({ ...dialog, ...(saveFormats[next] ?? saveFormats[0]) });
  } else actions.setDialog(editPath(dialog, input, key));
}

export function handleDialogInput(
  dialog: Dialog,
  input: string,
  key: Key,
  actions: DialogActions,
) {
  switch (dialog.type) {
    case "copy":
      handleCopyInput(dialog, key, actions);
      break;
    case "save":
      handleSaveInput(dialog, input, key, actions);
      break;
    case "replace":
      if (key.escape) actions.setDialog(dialog.save);
      else if (key.return) actions.save(dialog.save, true);
      break;
  }
}

function formatLabel(format: OutputFormat, pretty: boolean): string {
  if (format !== "json") return format.toUpperCase();

  return `JSON ${pretty ? "pretty" : "compact"}`;
}

function CopyDialogView({
  selected,
  height,
  pretty,
}: {
  selected: number;
  height: number;
  pretty: boolean;
}) {
  const vertical = height >= 5;

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Copy catalog
      </Text>
      <Box
        flexDirection={vertical ? "column" : "row"}
        gap={vertical ? 0 : 2}
        marginTop={vertical ? 1 : 0}
      >
        {formats.map((format, index) => (
          <Text
            key={format}
            bold={index === selected}
            {...(index === selected ? { color: "cyan" as const } : {})}
          >
            {(index === selected ? "› " : "  ") + formatLabel(format, pretty)}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function SaveDialogView({
  dialog,
  width,
  height,
}: {
  dialog: SaveDialog;
  width: number;
  height: number;
}) {
  const chars = Array.from(dialog.path);
  const before = safeText(chars.slice(0, dialog.cursor).join(""));
  const current = safeText(chars[dialog.cursor] ?? " ");
  const after = safeText(chars.slice(dialog.cursor + 1).join(""));
  const visibleBefore = Bun.sliceAnsi(before, -Math.max(1, width - 5));
  const remaining = Math.max(
    0,
    width - 2 - Bun.stringWidth(visibleBefore + current),
  );
  const detected =
    dialog.format === "auto" ? inferOutputFormat(dialog.path) : dialog.format;

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Save catalog
      </Text>
      <Box marginTop={height >= 5 ? 1 : 0}>
        <Text>
          {`> ${visibleBefore}`}
          <Text inverse>{current}</Text>
          {fitText(after, remaining)}
        </Text>
      </Box>
      <Text dimColor>
        {fitText(
          `Format: ${dialog.format === "auto" ? "auto · " : ""}${detected ? formatLabel(detected, dialog.pretty) : "use .json, .csv, or .tsv"}`,
          width,
        )}
      </Text>
      {height >= 6 && <Text dimColor>Tab / Shift+Tab cycle formats</Text>}
    </Box>
  );
}

export function DialogView({
  dialog,
  width,
  height,
  pretty,
}: {
  dialog: Dialog;
  width: number;
  height: number;
  pretty: boolean;
}) {
  if (dialog.type === "copy")
    return (
      <CopyDialogView
        selected={dialog.selected}
        height={height}
        pretty={pretty}
      />
    );

  if (dialog.type === "save")
    return <SaveDialogView dialog={dialog} width={width} height={height} />;

  return (
    <Box flexDirection="column">
      <Text bold color="yellow">
        Replace existing file?
      </Text>
      <Text>{fitText(resolve(dialog.save.path), width)}</Text>
      <Text dimColor>This will replace the complete file.</Text>
    </Box>
  );
}
