import { Box, Text } from "ink";
import { fitText, wrapText } from "./terminal-text";
import type { Completion, ResultItem } from "./types";

export const money = (price: number) =>
  "$" +
  price.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export const details = (row: ResultItem) =>
  row.name +
  "\n\n" +
  money(row.price) +
  "\n\n" +
  row.description +
  "\n\nColors: " +
  (row.colors?.join(", ") || "Not listed");

export function browserHelp(feedback: string, savedPath: string | undefined) {
  return (
    "Browse\n" +
    "Up/Down select a row. d/u or Ctrl+d/u move half a page down/up.\n" +
    "Space/Page Down move a full page down; b/Page Up move a full page up. g/Home and G/End jump to the first/last row.\n" +
    "Enter opens full product details. Use [ for the previous product and ] for the next. Escape returns. Tab switches Table and JSON.\n" +
    "JSON, details, and help use the same navigation keys to scroll. Each view remembers its position. In JSON, r toggles pretty/compact and returns to the top.\n\n" +
    "Export the whole catalog\n" +
    "c chooses a copy format. j copies JSON, v CSV, t TSV.\n" +
    "s opens Save. The filename selects the format by default. Tab cycles Auto, CSV, TSV, JSON compact, JSON pretty; Shift+Tab reverses.\n" +
    "Save lets you choose compact or pretty JSON directly. A successful JSON save updates the preview and future copies; cancelling keeps the previous setting. Existing files do not change when you toggle it.\n" +
    "In a path: arrows, Home/End, Backspace/Delete edit; Ctrl+u clears. Enter saves; Escape cancels.\n" +
    "Replacing an existing file requires confirmation.\n\n" +
    "Saved file\n" +
    "f opens the file in its default app. o opens its folder. p copies its absolute path.\n" +
    "Actions use the latest successful save. They never launch automatically.\n\n" +
    "Exit\n" +
    "q closes the browser. Ctrl+C cancels. Closing never saves automatically.\n" +
    "The terminal is restored and a completion summary remains.\n\n" +
    "Latest action\n" +
    (feedback || "No action yet.") +
    (savedPath ? `\nSaved file: ${savedPath}` : "\nNo file saved.")
  );
}

export function footerFor(
  view: "table" | "json" | "details" | "help",
  dialogType: "save" | "replace" | "copy" | undefined,
) {
  switch (dialogType) {
    case "save":
      return ["Enter - Save  Esc - Cancel", "Tab - Format  Ctrl+U - Clear"];
    case "replace":
      return [
        "Enter - Replace  Esc - Back",
        "The saved file changes only after confirmation.",
      ];
    case "copy":
      return ["↑/↓ - Choose  Enter - Copy", "Esc - Cancel"];
    default:
      return [
        {
          table: "↑/↓ - Move  Enter - Open  Tab - JSON",
          details: "[ - Previous  ] - Next  Esc - Back",
          json: "↑/↓ - Scroll  Tab - Table",
          help: "↑/↓ - Scroll  Esc - Back",
        }[view],
        "c - Copy  s - Save  ? - Help  q - Quit",
      ];
  }
}

export function BrowserTooSmall({
  width,
  height,
}: {
  width: number;
  height: number;
}) {
  const messages =
    height < 3
      ? ["q - Quit · resize terminal"]
      : ["Terminal too small", "Resize to 40 × 16", "q - Quit"];

  return (
    <Box flexDirection="column" height={height} width={width}>
      {messages.slice(0, Math.max(1, height)).map((message) => (
        <Text key={message} wrap="truncate-end">
          {fitText(message, width)}
        </Text>
      ))}
    </Box>
  );
}

export function BrowserHeader({
  completion,
  rowCount,
  view,
  pretty,
  contentWidth,
  narrow,
  dialogOpen,
}: {
  completion: Completion;
  rowCount: number;
  view: string;
  pretty: boolean;
  contentWidth: number;
  narrow: boolean;
  dialogOpen: boolean;
}) {
  return (
    <>
      <Text bold color="cyan">
        NATTER <Text>Catalog complete</Text>
      </Text>
      <Text wrap="truncate-end">
        {fitText(
          completion.productCount +
            " products · " +
            rowCount +
            " results" +
            (narrow ? "" : ` · Total ${money(completion.catalog.total)}`) +
            " · " +
            (completion.elapsedMs / 1000).toFixed(1) +
            "s",
          contentWidth,
        )}
      </Text>
      {narrow && <Text>Total {money(completion.catalog.total)}</Text>}
      <Box marginTop={narrow ? 0 : 1}>
        <Text
          {...(view === "table" ? { color: "cyan" as const } : {})}
          bold={view === "table"}
        >
          Table
        </Text>
        <Text dimColor> / </Text>
        <Text
          {...(view === "json" ? { color: "cyan" as const } : {})}
          bold={view === "json"}
        >
          {view === "json" && !dialogOpen
            ? `JSON · ${pretty ? "pretty" : "compact"}`
            : "JSON"}
        </Text>
        {view === "json" && !dialogOpen && <Text dimColor> r - Format</Text>}
      </Box>
    </>
  );
}

export function CatalogTable({
  rows,
  selected,
  width,
  height,
}: {
  rows: ResultItem[];
  selected: number;
  width: number;
  height: number;
}) {
  const count = Math.max(1, height - 2);
  const start = Math.floor(selected / count) * count;
  const numberWidth = String(rows.length).length + 3;
  const priceWidth = Math.min(
    22,
    Math.max(
      12,
      ...rows
        .slice(start, start + count)
        .map((item) => money(item.price).length + 1),
    ),
  );
  const nameWidth = Math.max(1, width - numberWidth - priceWidth);
  const pad = (value: string, size: number) => {
    const clipped = fitText(value, size);

    return clipped + " ".repeat(Math.max(0, size - Bun.stringWidth(clipped)));
  };

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text dimColor>
        {pad("  #", numberWidth) +
          pad("Name", nameWidth) +
          "Price".padStart(priceWidth)}
      </Text>
      <Box flexDirection="column" flexGrow={1}>
        {rows.slice(start, start + count).map((item, index) => {
          const number = start + index;
          const active = number === selected;
          const label = (active ? "› " : "  ") + (number + 1);

          return (
            <Text
              key={number}
              {...(active ? { color: "cyan" as const } : {})}
              bold={active}
            >
              {pad(label, numberWidth) +
                pad(item.name, nameWidth) +
                money(item.price).padStart(priceWidth)}
            </Text>
          );
        })}
      </Box>
      <Text dimColor>
        {`Row ${rows.length ? selected + 1 : 0} of ${rows.length}`}
      </Text>
    </Box>
  );
}

export function BrowserTableView({
  rows,
  selected,
  contentWidth,
  bodyHeight,
  wide,
  panelHeight,
  tableHeight,
}: {
  rows: ResultItem[];
  selected: number;
  contentWidth: number;
  bodyHeight: number;
  wide: boolean;
  panelHeight: number;
  tableHeight: number;
}) {
  const row = rows[selected];
  const tableWidth = wide ? Math.floor(contentWidth * 0.58) : contentWidth;
  const detailsWidth = wide ? contentWidth - tableWidth - 2 : contentWidth;

  return (
    <Box flexDirection={wide ? "row" : "column"} height={bodyHeight}>
      <CatalogTable
        rows={rows}
        selected={selected}
        width={tableWidth}
        height={tableHeight}
      />
      {row && (wide || panelHeight > 0) && (
        <Box
          flexDirection="column"
          width={detailsWidth}
          height={wide ? bodyHeight : panelHeight}
          marginLeft={wide ? 2 : 0}
        >
          <Text bold color="cyan">
            Selected row <Text dimColor>· Enter for full details</Text>
          </Text>
          {wide ? (
            <Text>
              {wrapText(details(row), detailsWidth)
                .slice(0, bodyHeight - 1)
                .join("\n")}
            </Text>
          ) : (
            <>
              <Text>{fitText(row.name, contentWidth)}</Text>
              <Box height={2}>
                <Text>
                  {wrapText(row.description, contentWidth)
                    .slice(0, 2)
                    .join("\n")}
                </Text>
              </Box>
              <Text dimColor>
                {fitText(
                  `Colors: ${row.colors?.join(", ") || "Not listed"}`,
                  contentWidth,
                )}
              </Text>
            </>
          )}
        </Box>
      )}
    </Box>
  );
}

export function BrowserTextView({
  view,
  lines,
  offset,
  visibleLines,
  bodyHeight,
}: {
  view: "json" | "details" | "help";
  lines: string[];
  offset: number;
  visibleLines: number;
  bodyHeight: number;
}) {
  const title = {
    details: "Product details",
    help: "Help",
    json: "JSON preview",
  }[view];

  return (
    <Box flexDirection="column" height={bodyHeight}>
      <Text bold color="cyan">
        {title}
        <Text dimColor>
          {" · " +
            (offset + 1) +
            "–" +
            Math.min(lines.length, offset + visibleLines) +
            " of " +
            lines.length +
            " lines"}
        </Text>
      </Text>
      <Text>{lines.slice(offset, offset + visibleLines).join("\n")}</Text>
    </Box>
  );
}

export function BrowserFooter({
  savedPath,
  feedback,
  working,
  contentWidth,
  footer,
  dialogOpen,
}: {
  savedPath: string | undefined;
  feedback: string;
  working: boolean;
  contentWidth: number;
  footer: string[];
  dialogOpen: boolean;
}) {
  return (
    <>
      <Box marginTop={1}>
        <Text dimColor wrap="truncate-end">
          {fitText(
            savedPath
              ? `Saved ${savedPath}`
              : "No file saved · Copy or Save to keep this catalog",
            contentWidth,
          )}
        </Text>
      </Box>
      <Text color={working ? "yellow" : "cyan"} wrap="truncate-end">
        {fitText(
          feedback ||
            (savedPath
              ? "File actions use the latest successful save."
              : "Copy and Save export the whole catalog."),
          contentWidth,
        ) || " "}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {footer.map((line) => (
          <Text key={line} wrap="truncate-end">
            {fitText(line, contentWidth)}
          </Text>
        ))}
        {savedPath && (
          <Text dimColor>
            {dialogOpen
              ? "Ctrl+C - Cancel"
              : "f - Open  o - Folder  p - Copy path"}
          </Text>
        )}
      </Box>
    </>
  );
}
