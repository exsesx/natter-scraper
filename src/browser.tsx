import type { Fiber } from "effect";
import { Box, type Key, useInput } from "ink";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useBrowserActions } from "./browser-actions";
import { DialogView, handleDialogInput } from "./browser-dialogs";
import {
  BrowserFooter,
  BrowserHeader,
  BrowserTableView,
  BrowserTextView,
  BrowserTooSmall,
  browserHelp,
  details,
  footerFor,
} from "./browser-views";
import type { DesktopActions } from "./desktop";
import { serializeCatalog } from "./format";
import type { writeResult } from "./output";
import { wrapText } from "./terminal-text";
import type { Completion, ResultItem } from "./types";

type View = "table" | "json" | "details" | "help";

export interface BrowserProps {
  completion: Completion;
  desktop: DesktopActions;
  width: number;
  height: number;
  saveOutput?: typeof writeResult;
  onClose(code: number): void;
  onSaved?(path: string): void;
  onActionFiber?(fiber: Fiber.Fiber<void>): void;
}

function navigationOffset(
  input: string,
  key: Key,
  current: number,
  last: number,
  page: number,
) {
  let next = current;

  if (key.home || input === "g") next = 0;
  else if (key.end || input === "G") next = last;
  else if (key.upArrow) next--;
  else if (key.downArrow) next++;
  else if (key.pageUp || input === "b") next -= page;
  else if (key.pageDown || input === " ") next += page;
  else if (input === "u") next -= Math.max(1, Math.floor(page / 2));
  else if (input === "d") next += Math.max(1, Math.floor(page / 2));

  return Math.max(0, Math.min(last, next));
}

function viewText(
  view: View,
  json: string,
  row: ResultItem | undefined,
  help: string,
) {
  if (view === "json") return json;

  if (view === "details" && row) return details(row);

  if (view === "help") return help;

  return "";
}

export function ResultBrowser(props: BrowserProps) {
  const { completion, width, height, onClose } = props;
  const [view, setView] = useState<View>("table");
  const [returnView, setReturnView] = useState<View>("table");
  const [selected, setSelected] = useState(0);
  const [scroll, setScroll] = useState({ json: 0, details: 0, help: 0 });
  const [pretty, setPretty] = useState(completion.pretty);
  const [ready, setReady] = useState(false);
  const actions = useBrowserActions({
    ...props,
    pretty,
    onPrettyChange: changePretty,
  });
  const { savedPath, dialog, feedback, working, busy } = actions;
  const rows = completion.catalog.results;
  const row = rows[selected];
  const contentWidth = Math.max(1, width - 2);
  const bodyHeight = Math.max(1, height - 11 - (savedPath ? 1 : 0));
  const narrow = contentWidth < 64;
  const tooSmall = width < 40 || height < 15;
  const wide = contentWidth >= 100 && bodyHeight >= 8;
  const panelHeight = !wide && bodyHeight >= 12 ? 5 : 0;
  const tableHeight = bodyHeight - panelHeight;
  const pageSize = Math.max(1, tableHeight - 2);
  const json = useMemo(
    () => serializeCatalog(completion.catalog, { pretty }).trimEnd(),
    [completion.catalog, pretty],
  );
  const text = viewText(view, json, row, browserHelp(feedback, savedPath));
  const lines = useMemo(
    () => wrapText(text, contentWidth),
    [text, contentWidth],
  );
  const visibleLines = Math.max(1, bodyHeight - 1);
  const offset = Math.min(
    view === "table" ? 0 : scroll[view],
    Math.max(0, lines.length - visibleLines),
  );

  useEffect(() => setReady(true), []);

  function changePretty(next: boolean) {
    if (next === pretty) return;

    setPretty(next);
    setScroll((current) => ({ ...current, json: 0 }));
  }

  function selectRow(index: number) {
    const next = Math.max(0, Math.min(rows.length - 1, index));

    if (next === selected) return;

    setSelected(next);
    setScroll((current) => ({ ...current, details: 0 }));
  }

  function handleViewInput(input: string, key: Key): boolean {
    if (key.escape && view !== "table")
      setView(view === "help" ? returnView : "table");
    else if (key.tab) setView(view === "json" ? "table" : "json");
    else if (input === "?") {
      if (view === "help") setView(returnView);
      else {
        setReturnView(view);
        setView("help");
      }
    } else if (input === "r" && view === "json") changePretty(!pretty);
    else if (view === "details" && (input === "[" || input === "]"))
      selectRow(selected + (input === "]" ? 1 : -1));
    else if (key.return && view === "table" && row) setView("details");
    else return false;

    return true;
  }

  function navigate(input: string, key: Key) {
    if (view === "table") {
      selectRow(
        navigationOffset(input, key, selected, rows.length - 1, pageSize),
      );
    } else {
      const next = navigationOffset(
        input,
        key,
        offset,
        Math.max(0, lines.length - visibleLines),
        visibleLines,
      );

      if (next !== offset)
        setScroll((current) => ({ ...current, [view]: next }));
    }
  }

  function handleInput(input: string, key: Key) {
    if (dialog) {
      handleDialogInput(dialog, input, key, actions);

      return;
    }

    if (input === "q") {
      onClose(0);

      return;
    }

    if (handleViewInput(input, key) || actions.handleShortcut(input)) return;

    navigate(input, key);
  }

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onClose(130);

      return;
    }

    if (tooSmall || busy.current) {
      if (input === "q" && (tooSmall || !dialog)) onClose(0);

      return;
    }

    handleInput(input, key);
  });

  if (!ready) return null;

  if (tooSmall) return <BrowserTooSmall width={width} height={height} />;

  let body: ReactNode;

  if (dialog) {
    body = (
      <DialogView
        dialog={dialog}
        width={contentWidth}
        height={bodyHeight}
        pretty={pretty}
      />
    );
  } else if (view === "table") {
    body = (
      <BrowserTableView
        rows={rows}
        selected={selected}
        contentWidth={contentWidth}
        bodyHeight={bodyHeight}
        wide={wide}
        panelHeight={panelHeight}
        tableHeight={tableHeight}
      />
    );
  } else {
    body = (
      <BrowserTextView
        view={view}
        lines={lines}
        offset={offset}
        visibleLines={visibleLines}
        bodyHeight={bodyHeight}
      />
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <BrowserHeader
        completion={completion}
        rowCount={rows.length}
        view={view}
        pretty={pretty}
        contentWidth={contentWidth}
        narrow={narrow}
        dialogOpen={dialog !== undefined}
      />
      <Box
        marginTop={1}
        height={bodyHeight}
        flexDirection="column"
        overflow="hidden"
      >
        {body}
      </Box>
      <BrowserFooter
        savedPath={savedPath}
        feedback={feedback}
        working={working}
        contentWidth={contentWidth}
        footer={footerFor(view, dialog?.type)}
        dialogOpen={dialog !== undefined}
      />
    </Box>
  );
}
