import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { Effect, Exit, Fiber } from "effect";
import { render } from "ink";
import { type DesktopActions, DesktopError } from "../src/desktop";
import { serializeCatalog } from "../src/format";
import { OutputError, type writeResult } from "../src/output";
import type { Completion, Progress } from "../src/types";
import { createTerminalUI, TerminalView } from "../src/ui";

const progress: Progress = {
  phase: "discovering",
  pages: 2,
  discoveredProducts: 3,
  processedProducts: 1,
  queued: 2,
  active: 1,
  retries: 0,
};
const completion: Completion = {
  catalog: {
    results: [
      {
        name: 'Phone, "Gold"',
        description: "A\tB\nC",
        price: 12.34,
        colors: ["Gold", "Blue"],
      },
    ],
    total: 12.34,
  },
  format: "json",
  pretty: false,
  productCount: 3,
  elapsedMs: 1500,
};
const keys = {
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
  home: "\u001b[H",
  end: "\u001b[F",
  pageUp: "\u001b[5~",
  pageDown: "\u001b[6~",
  delete: "\u001b[3~",
  backspace: "\u007f",
  escape: "\u001b",
  enter: "\r",
  tab: "\t",
  shiftTab: "\u001b[Z",
  clear: "\u0015",
  cancel: "\u0003",
};
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

function terminalStreams(columns = 100, rows = 30) {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode(value: boolean): void;
    ref(): void;
    unref(): void;
  };
  const output = new PassThrough() as PassThrough & {
    columns: number;
    rows: number;
    isTTY: boolean;
  };
  const raw: boolean[] = [];
  const chunks: string[] = [];
  let frame = "";

  input.isTTY = true;
  input.setRawMode = (value) => raw.push(value);
  input.ref = () => {};
  input.unref = () => {};
  output.columns = columns;
  output.rows = rows;
  output.isTTY = true;
  output.on("data", (chunk) => {
    const text = String(chunk);
    const visible = stripVTControlCharacters(text);
    chunks.push(text);

    // Ink's debug renderer writes each complete frame in one chunk. Ignore
    // cursor-control writes so assertions inspect the current visible frame.
    if (visible.trim()) frame = visible;
  });

  return {
    input,
    output,
    raw,
    frame: () => frame,
    history: () => chunks.join(""),
  };
}

async function screen(
  result?: Completion,
  options: {
    desktop?: Partial<DesktopActions>;
    saveOutput?: typeof writeResult;
    columns?: number;
    rows?: number;
  } = {},
) {
  const streams = terminalStreams(options.columns, options.rows);
  const copies: string[] = [];
  const folders: string[] = [];
  const files: string[] = [];
  const saves: {
    text: string;
    path: string | undefined;
    overwrite: boolean | undefined;
  }[] = [];
  const exits: number[] = [];
  let cancels = 0;
  const instance = render(
    <TerminalView
      progress={progress}
      {...(result ? { completion: result } : {})}
      desktop={{
        copy: (text) =>
          Effect.sync(() => {
            copies.push(text);
          }),
        openFolder: (path) =>
          Effect.sync(() => {
            folders.push(path);
          }),
        openFile: (path) =>
          Effect.sync(() => {
            files.push(path);
          }),
        ...options.desktop,
      }}
      saveOutput={
        options.saveOutput ??
        ((text, saveOptions = {}) =>
          Effect.sync(() => {
            saves.push({
              text,
              path: saveOptions.path,
              overwrite: saveOptions.overwrite,
            });

            return saveOptions.path;
          }))
      }
      onCancel={() => {
        cancels++;
      }}
      onClose={(code) => {
        exits.push(code);
      }}
    />,
    {
      stdin: streams.input as unknown as NodeJS.ReadStream,
      stdout: streams.output as unknown as NodeJS.WriteStream,
      stderr: streams.output as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
      debug: true,
    },
  );

  cleanups.push(() => {
    instance.unmount();
    streams.input.destroy();
    streams.output.destroy();
  });

  await tick();

  return {
    ...streams,
    copies,
    folders,
    files,
    saves,
    exits,
    instance,
    cancels: () => cancels,
    text: streams.frame,
    async key(value: string) {
      streams.input.write(value);
      await tick();
    },
    async resize(columns: number, rows: number) {
      streams.output.columns = columns;
      streams.output.rows = rows;
      streams.output.emit("resize");
      await tick();
    },
  };
}

const largeCompletion: Completion = {
  ...completion,
  catalog: {
    results: Array.from({ length: 50 }, (_, index) => ({
      name: `Product ${String(index + 1).padStart(2, "0")}`,
      description: `Full description of item ${index + 1}`,
      price: index + 1,
    })),
    total: 1275,
  },
  productCount: 50,
};

test("loaded catalogs omit crawl metadata and enable actions for the input file", async () => {
  const inputPath = resolve("saved catalog.json");
  const view = await screen({
    catalog: completion.catalog,
    format: "json",
    pretty: true,
    outputPath: inputPath,
  });

  expect(view.text()).toContain("Catalog loaded");
  expect(view.text()).toContain("1 results · Total $12.34");
  expect(view.text()).not.toContain("products ·");
  expect(view.text()).not.toContain("NaN");

  for (const key of ["p", "f", "o", "j"]) await view.key(key);

  expect(view.files).toEqual([inputPath]);
  expect(view.folders).toEqual([inputPath]);
  expect(view.copies).toEqual([
    inputPath,
    serializeCatalog(completion.catalog, { pretty: true }),
  ]);
  expect(view.saves).toEqual([]);

  await view.resize(40, 16);

  expect(view.text()).toContain("Catalog loaded");
  expect(view.text()).toContain("Total $12.34");
  expect(view.text().trimEnd().split("\n").length).toBeLessThanOrEqual(16);
});

test("empty loaded catalogs remain browsable and exportable", async () => {
  const catalog = { results: [], total: 0 };
  const view = await screen({ catalog, format: "json", pretty: true });

  expect(view.text()).toContain("Row 0 of 0");

  for (const key of [keys.down, "G", keys.enter]) await view.key(key);

  expect(view.text()).toContain("Row 0 of 0");

  await view.key(keys.tab);

  expect(view.text()).toContain('"results": []');
  expect(view.text()).toContain('"total": 0');

  await view.key("j");

  expect(view.copies).toEqual([serializeCatalog(catalog, { pretty: true })]);

  await view.key("q");

  expect(view.exits).toEqual([0]);
});

test("running view reports counts and only Ctrl+C cancels", async () => {
  const view = await screen();

  expect(view.text()).toContain("Discovering catalog");
  expect(view.text()).toContain("1 read");

  for (const key of ["c", "q", "s", "f", keys.enter]) await view.key(key);

  expect(view.copies).toEqual([]);
  expect(view.saves).toEqual([]);
  expect(view.exits).toEqual([]);

  await view.key(keys.cancel);

  expect(view.cancels()).toBe(1);

  view.instance.unmount();

  expect(view.raw.at(-1)).toBe(false);
});

test("Ctrl+C closes the result browser even while a save dialog is open", async () => {
  const view = await screen(completion);

  await view.key("s");
  await view.key(keys.cancel);

  expect(view.exits).toEqual([130]);
  expect(view.cancels()).toBe(0);
  expect(view.saves).toEqual([]);
});

test("table scrolls to every row, opens selected details, and returns without exiting", async () => {
  const view = await screen(largeCompletion, { rows: 20 });

  expect(view.text()).toContain("Product 01");
  expect(view.text()).not.toContain("Product 50");
  expect(view.text().trimEnd().split("\n").length).toBeLessThanOrEqual(20);

  await view.key(keys.down);
  await view.key(keys.enter);

  expect(view.text()).toContain("Full description of item 2");
  expect(view.exits).toEqual([]);

  await view.key(keys.escape);
  await view.key(keys.pageDown);

  expect(view.text()).not.toContain("Product 01");

  await view.key(keys.end);

  expect(view.text()).toContain("Product 50");
  expect(view.text()).not.toContain("Product 01");

  await view.key(keys.enter);

  expect(view.text()).toContain("Full description of item 50");

  await view.key(keys.escape);
  await view.key(keys.home);

  expect(view.text()).toContain("Product 01");
  expect(view.text()).not.toContain("Product 50");

  await view.key("q");

  expect(view.exits).toEqual([0]);
});

test("switching views and dismissing help restores independent scroll positions", async () => {
  const view = await screen({ ...largeCompletion, pretty: true }, { rows: 20 });

  await view.key("d");
  await view.key(keys.tab);
  await view.key(keys.pageDown);

  const jsonFrame = view.text();

  expect(jsonFrame).toContain("JSON preview · 8–14 of ");

  await view.key("?");
  await view.key(keys.pageDown);

  const helpFrame = view.text();

  expect(helpFrame).toContain("Help · 8–14 of ");

  await view.key(keys.escape);

  expect(view.text()).toBe(jsonFrame);

  await view.key(keys.tab);

  expect(view.text()).toContain("Row 4 of 50");

  await view.key(keys.tab);

  expect(view.text()).toBe(jsonFrame);

  await view.key("?");

  expect(view.text()).toBe(helpFrame);

  await view.key("?");

  expect(view.text()).toBe(jsonFrame);
  expect(view.copies).toEqual([]);
  expect(view.saves).toEqual([]);
});

test("details retain their position until selecting another product, with bounded bracket navigation", async () => {
  const view = await screen(
    {
      ...completion,
      catalog: {
        results: [1, 2].map((number) => ({
          name: `Product ${number}`,
          description: Array.from(
            { length: 30 },
            (_, line) => `Product ${number} description line ${line + 1}`,
          ).join("\n"),
          price: number,
        })),
        total: 3,
      },
      productCount: 2,
    },
    { rows: 20 },
  );

  await view.key(keys.enter);
  await view.key("d");

  const detailsFrame = view.text();

  expect(detailsFrame).toContain("Product details · 4–10 of ");

  await view.key("[");

  expect(view.text()).toBe(detailsFrame);

  await view.key("?");
  await view.key(keys.end);
  await view.key(keys.escape);

  expect(view.text()).toBe(detailsFrame);

  await view.key(keys.escape);
  await view.key(keys.enter);

  expect(view.text()).toBe(detailsFrame);

  await view.key("]");

  expect(view.text()).toContain("Product details · 1–7 of ");
  expect(view.text()).toContain("Product 2");

  await view.key("d");

  const lastProductFrame = view.text();

  await view.key("]");

  expect(view.text()).toBe(lastProductFrame);

  await view.key(keys.escape);

  expect(view.text()).toContain("Row 2 of 2");

  await view.key(keys.enter);
  await view.key("[");

  expect(view.text()).toContain("Product details · 1–7 of ");
  expect(view.text()).toContain("Product 1");

  await view.key("d");
  await view.key(keys.escape);
  await view.key(keys.down);
  await view.key(keys.enter);

  expect(view.text()).toContain("Product details · 1–7 of ");
  expect(view.text()).toContain("Product 2");
  expect(view.exits).toEqual([]);
});

test("JSON formatting controls appear only in JSON and leave other views unchanged", async () => {
  const view = await screen({ ...largeCompletion, pretty: true }, { rows: 20 });

  expect(view.text()).not.toContain("r - Format");
  expect(view.text()).not.toContain("JSON · pretty");

  await view.key("r");
  await view.key(keys.enter);

  expect(view.text()).toContain("[ - Previous  ] - Next");
  expect(view.text()).not.toContain("r - Format");

  await view.key(keys.tab);

  expect(view.text()).toContain("JSON · pretty r - Format");
  expect(view.text()).toContain("Tab - Table");
  expect(view.text()).not.toContain("[ - Previous  ] - Next");

  await view.key("d");
  await view.key("r");

  expect(view.text()).toContain("JSON · compact r - Format");
  expect(view.text()).toContain("JSON preview · 1–7 of ");

  await view.key("s");

  expect(view.text()).not.toContain("r - Format");

  await view.key(keys.clear);
  await view.key("gG[d]u.json");
  await view.key(keys.enter);

  expect(view.saves.at(-1)?.path).toBe(resolve("gG[d]u.json"));
  expect(view.saves.at(-1)?.text).toBe(
    serializeCatalog(largeCompletion.catalog, { pretty: false }),
  );
});

test("JSON view and copies use the entire catalog and current pretty setting", async () => {
  const result = { ...largeCompletion, pretty: true };
  const view = await screen(result, { rows: 20 });

  await view.key(keys.tab);

  expect(view.text()).toContain('"results"');
  expect(view.text()).toContain('"name"');

  await view.key("j");

  expect(view.copies.at(-1)).toBe(
    serializeCatalog(result.catalog, { format: "json", pretty: true }),
  );
  expect(JSON.parse(view.copies[0] ?? "").results).toHaveLength(50);

  await view.key("r");
  await view.key("j");

  expect(view.copies.at(-1)).toBe(
    serializeCatalog(result.catalog, { format: "json", pretty: false }),
  );
  expect(view.text().trimEnd().split("\n").length).toBeLessThanOrEqual(20);

  await view.key(keys.tab);

  expect(view.text()).toContain("Product 01");

  await view.key(keys.tab);

  expect(view.text()).toContain("JSON preview");

  await view.key(keys.escape);

  expect(view.text()).toContain("Product 01");
  expect(view.text()).not.toContain("JSON preview");
});

test("pager keys move by visible half and full pages, clamp at edges, and follow resize", async () => {
  const view = await screen(largeCompletion, { rows: 20 });

  // This terminal fits six table rows. The selected row moves by three or six.
  for (const [key, row] of [
    ["d", 4],
    ["\u0004", 7],
    ["u", 4],
    [keys.clear, 1],
    [" ", 7],
    ["b", 1],
    ["u", 1],
    ["b", 1],
    [keys.end, 50],
    ["d", 50],
    [" ", 50],
    [keys.home, 1],
    ["G", 50],
    ["g", 1],
  ] as const) {
    await view.key(key);

    expect(view.text()).toContain(`Row ${row} of 50`);
  }

  await view.resize(40, 16);
  await view.key("d");

  expect(view.text()).toContain("Row 2 of 50");

  await view.key(" ");

  expect(view.text()).toContain("Row 4 of 50");

  await view.resize(100, 24);
  await view.key(keys.home);
  await view.key("d");

  // Five rows now fit, so a half page rounds down to two rows.
  expect(view.text()).toContain("Row 3 of 50");
  expect(view.exits).toEqual([]);
  expect(view.copies).toEqual([]);
  expect(view.saves).toEqual([]);
});

for (const [key, title] of [
  [keys.tab, "JSON preview"],
  [keys.enter, "Product details"],
  ["?", "Help"],
] as const) {
  test(`pager keys scroll ${title} by visible lines without exporting`, async () => {
    const view = await screen(
      {
        ...largeCompletion,
        pretty: true,
        catalog: {
          ...largeCompletion.catalog,
          results: largeCompletion.catalog.results.map((row) => ({
            ...row,
            description: Array.from(
              { length: 30 },
              (_, index) => `Description line ${index + 1}`,
            ).join("\n"),
          })),
        },
      },
      { rows: 20 },
    );

    await view.key(key);

    // Text views show seven lines here. Half a page rounds down to three.
    for (const [input, first, last] of [
      ["d", 4, 10],
      [" ", 11, 17],
      ["b", 4, 10],
      ["u", 1, 7],
      ["u", 1, 7],
      ["\u0004", 4, 10],
      [keys.clear, 1, 7],
    ] as const) {
      await view.key(input);

      expect(view.text()).toContain(`${title} · ${first}–${last} of `);
    }

    await view.key(keys.end);

    const end = view.text();

    await view.key("d");
    await view.key(" ");

    expect(view.text()).toBe(end);

    await view.key("g");

    expect(view.text()).toContain(`${title} · 1–7 of `);

    await view.key("G");

    expect(view.text()).toBe(end);
    expect(view.exits).toEqual([]);
    expect(view.copies).toEqual([]);
    expect(view.saves).toEqual([]);
  });
}

test("responsive layouts keep the total, navigation, and selected product information visible", async () => {
  const view = await screen(
    {
      ...completion,
      catalog: {
        results: completion.catalog.results.map((row) => ({
          ...row,
          price: 345701.52,
        })),
        total: 345701.52,
      },
    },
    { columns: 80, rows: 30 },
  );

  expect(view.text()).toContain("Selected row");
  expect(view.text()).toContain("A    B");
  expect(view.text()).toContain("Colors: Gold, Blue");

  await view.resize(40, 16);

  expect(view.text()).toContain("Total $345,701.52");
  expect(view.text()).toContain("Tab - JSON");
  expect(view.text()).toContain("q - Quit");

  await view.key(keys.enter);

  expect(view.text()).toContain("[ - Previous  ] - Next  Esc - Back");
  expect(view.text()).toContain("q - Quit");
  expect(view.text().trimEnd().split("\n").length).toBeLessThanOrEqual(15);
  expect(
    view
      .text()
      .split("\n")
      .every((line) => Bun.stringWidth(line) <= 40),
  ).toBe(true);
});

for (const format of ["json", "csv", "tsv"] as const) {
  test(`${format} completion copies every format and remembers the latest selection`, async () => {
    const result = { ...completion, format, pretty: true };
    const view = await screen(result);

    await view.key("c");

    expect(view.copies).toEqual([]);
    expect(view.text()).toContain("JSON");
    expect(view.text()).toContain("CSV");
    expect(view.text()).toContain("TSV");

    await view.key(keys.escape);

    expect(view.copies).toEqual([]);

    await view.key("c");
    await view.key(keys.enter);

    expect(view.copies).toEqual([
      serializeCatalog(result.catalog, { format, pretty: true }),
    ]);

    for (const [key, requested] of [
      ["j", "json"],
      ["v", "csv"],
      ["t", "tsv"],
    ] as const) {
      await view.key(key);

      expect(view.copies.at(-1)).toBe(
        serializeCatalog(result.catalog, { format: requested, pretty: true }),
      );
      expect(view.text()).toContain(`${requested.toUpperCase()} copied`);
    }

    await view.key("c");
    await view.key(keys.enter);

    expect(view.copies.at(-1)).toBe(
      serializeCatalog(result.catalog, { format: "tsv", pretty: true }),
    );

    await view.key("s");

    expect(view.text()).toContain("catalog.tsv");
    expect(view.saves).toEqual([]);
  });
}

test("copy chooser arrows select a format and Enter copies without closing", async () => {
  const view = await screen(completion);

  await view.key("c");
  await view.key(keys.down);
  await view.key(keys.enter);

  expect(view.copies).toEqual([
    serializeCatalog(completion.catalog, { format: "csv" }),
  ]);
  expect(view.exits).toEqual([]);
});

test("unsaved completion ignores file actions; successful saves enable the latest path", async () => {
  const view = await screen(completion);

  for (const key of ["p", "o", "f"]) await view.key(key);

  expect(view.copies).toEqual([]);
  expect(view.folders).toEqual([]);
  expect(view.files).toEqual([]);

  await view.key("s");

  expect(view.text()).toContain("catalog.json");
  expect(view.text()).toContain("Format: auto · JSON compact");
  expect(view.saves).toEqual([]);

  await view.key(keys.enter);

  expect(view.saves).toEqual([
    {
      text: serializeCatalog(completion.catalog, { format: "json" }),
      path: resolve("catalog.json"),
      overwrite: false,
    },
  ]);
  expect(view.text()).toMatch(/f - Open\s+o - Folder\s+p - Copy path/u);

  await view.key("s");

  expect(view.text()).not.toContain("f - Open");
  expect(view.text()).toContain("Ctrl+C - Cancel");

  await view.key(keys.clear);
  await view.key("new catalog.csv");

  expect(view.text()).toContain("Format: auto · CSV");

  await view.key(keys.enter);

  expect(view.saves.at(-1)).toEqual({
    text: serializeCatalog(completion.catalog, { format: "csv" }),
    path: resolve("new catalog.csv"),
    overwrite: false,
  });

  for (const key of ["p", "o", "f"]) {
    await view.key(key);

    expect(view.text()).toMatch(/f - Open\s+o - Folder\s+p - Copy path/u);
  }

  expect(view.copies).toEqual([resolve("new catalog.csv")]);
  expect(view.folders).toEqual([resolve("new catalog.csv")]);
  expect(view.files).toEqual([resolve("new catalog.csv")]);
});

test("save prompt edits a pasted filename without triggering global shortcuts", async () => {
  const view = await screen(completion);

  await view.key("s");
  await view.key(keys.clear);
  await view.key("qcsfopjvt?.csv");
  await view.key(keys.home);
  await view.key("A");
  await view.key(keys.right);
  await view.key(keys.delete);
  await view.key(keys.end);
  await view.key(keys.backspace);
  await view.key("v");
  await view.key(keys.home);

  for (const key of ["d", "u", "b", " "]) await view.key(key);

  expect(view.exits).toEqual([]);
  expect(view.copies).toEqual([]);
  expect(view.files).toEqual([]);
  expect(view.folders).toEqual([]);
  expect(view.saves).toEqual([]);

  await view.key(keys.enter);

  expect(view.saves.at(-1)?.path).toBe(resolve("dub Aqsfopjvt?.csv"));
  expect(view.saves.at(-1)?.text).toBe(
    serializeCatalog(completion.catalog, { format: "csv" }),
  );
});

test("save format override takes precedence over filename extension; Escape cancels", async () => {
  const view = await screen(completion);

  await view.key("s");
  await view.key(keys.clear);
  await view.key("products.csv");
  await view.key(keys.tab);
  await view.key(keys.tab);
  await view.key(keys.tab);
  await view.key(keys.enter);

  expect(view.saves).toEqual([
    {
      text: serializeCatalog(completion.catalog, { format: "json" }),
      path: resolve("products.csv"),
      overwrite: false,
    },
  ]);

  await view.key("s");
  await view.key(keys.clear);
  await view.key("cancelled.json");
  await view.key(keys.escape);

  expect(view.saves).toHaveLength(1);
  expect(view.exits).toEqual([]);
});

test("Save cycles both ways through all formats without changing the path or cancelled JSON settings", async () => {
  const view = await screen(completion);

  await view.key("s");

  expect(view.text()).not.toContain("r - Format");

  for (const label of [
    "CSV",
    "TSV",
    "JSON compact",
    "JSON pretty",
    "auto · JSON pretty",
  ]) {
    await view.key(keys.tab);

    expect(view.text()).toContain(`Format: ${label}`);
    expect(view.text()).toContain("> catalog.json");
  }

  for (const label of [
    "JSON pretty",
    "JSON compact",
    "TSV",
    "CSV",
    "auto · JSON compact",
    "JSON pretty",
  ]) {
    await view.key(keys.shiftTab);

    expect(view.text()).toContain(`Format: ${label}`);
  }

  await view.key(keys.escape);
  await view.key("j");

  expect(view.copies).toEqual([
    serializeCatalog(completion.catalog, { pretty: false }),
  ]);
  expect(view.saves).toEqual([]);

  await view.key(keys.tab);

  expect(view.text()).toContain("JSON · compact r - Format");
});

for (const pretty of [false, true]) {
  test(`Save writes ${pretty ? "pretty" : "compact"} JSON and remembers it for previews, copies, and later saves`, async () => {
    const view = await screen({ ...completion, pretty: !pretty });

    await view.key("s");
    await view.key(keys.shiftTab);

    if (!pretty) await view.key(keys.shiftTab);

    expect(view.text()).toContain(
      `Format: JSON ${pretty ? "pretty" : "compact"}`,
    );

    await view.key(keys.enter);
    await view.key("j");

    const expected = serializeCatalog(completion.catalog, { pretty });

    expect(view.saves.at(-1)?.text).toBe(expected);
    expect(view.copies).toEqual([expected]);

    await view.key(keys.tab);

    expect(view.text()).toContain(`JSON · ${pretty ? "pretty" : "compact"}`);

    await view.key("s");

    expect(view.text()).toContain(
      `Format: auto · JSON ${pretty ? "pretty" : "compact"}`,
    );
  });
}

test("Save retains JSON formatting through replacement confirmation", async () => {
  const attempts: { text: string; overwrite: boolean | undefined }[] = [];
  const view = await screen(completion, {
    saveOutput: (text, options = {}) =>
      Effect.suspend(() => {
        attempts.push({ text, overwrite: options.overwrite });

        return options.overwrite
          ? Effect.succeed(options.path)
          : Effect.fail(
              new OutputError({ message: "Already exists", code: "EEXIST" }),
            );
      }),
  });

  await view.key(keys.tab);
  await view.key("s");
  await view.key(keys.shiftTab);
  await view.key(keys.enter);

  expect(view.text()).toContain("Replace existing file?");
  expect(view.text()).not.toContain("r - Format");

  await view.key(keys.escape);

  expect(view.text()).toContain("Format: JSON pretty");

  await view.key(keys.enter);
  await view.key(keys.enter);

  const expected = serializeCatalog(completion.catalog, { pretty: true });

  expect(attempts).toEqual([
    { text: expected, overwrite: false },
    { text: expected, overwrite: false },
    { text: expected, overwrite: true },
  ]);
  expect(view.text()).toContain("JSON · pretty r - Format");
});

test("existing save destination requires confirmation and Escape preserves the saved path", async () => {
  const original = join(tmpdir(), "original.json");
  const attempts: { text: string; path?: string; overwrite?: boolean }[] = [];
  const view = await screen(
    { ...completion, outputPath: original },
    {
      saveOutput: (text, options = {}) =>
        Effect.suspend(() => {
          attempts.push({ text, ...options });

          return options.overwrite
            ? Effect.succeed(options.path)
            : Effect.fail(
                new OutputError({
                  message: "Destination already exists",
                  code: "EEXIST",
                }),
              );
        }),
    },
  );

  await view.key("s");
  await view.key(keys.clear);
  await view.key("existing.csv");
  await view.key(keys.enter);

  expect(attempts).toHaveLength(1);
  expect(attempts[0]?.overwrite).toBe(false);
  expect(view.text()).toContain("Replace existing file?");

  await view.key(keys.escape);

  expect(view.text()).toContain("Save catalog");

  await view.key(keys.escape);
  await view.key("p");

  expect(attempts).toHaveLength(1);
  expect(view.copies).toEqual([original]);

  await view.key("s");
  await view.key(keys.clear);
  await view.key("existing.csv");
  await view.key(keys.enter);
  await view.key(keys.enter);
  await view.key("p");

  expect(attempts.map((attempt) => attempt.overwrite)).toEqual([
    false,
    false,
    true,
  ]);
  expect(attempts[2]?.path).toBe(resolve("existing.csv"));
  expect(attempts[2]?.text).toBe(
    serializeCatalog(completion.catalog, { format: "csv" }),
  );
  expect(view.copies.at(-1)).toBe(resolve("existing.csv"));
});

test("failed save keeps the previous successful path and allows a retry", async () => {
  const original = join(tmpdir(), "original.json");
  let attempts = 0;
  const view = await screen(
    { ...completion, outputPath: original },
    {
      saveOutput: (_text, options = {}) =>
        Effect.suspend(() => {
          attempts++;

          return attempts === 1
            ? Effect.fail(
                new OutputError({
                  message: "Directory is not writable",
                  code: "EACCES",
                }),
              )
            : Effect.succeed(options.path);
        }),
    },
  );

  await view.key("s");
  await view.key(keys.shiftTab);
  await view.key(keys.enter);

  expect(view.text()).toContain("Directory is not writable");

  await view.key(keys.escape);
  await view.key("p");

  expect(view.copies).toEqual([original]);

  await view.key("j");

  expect(view.copies.at(-1)).toBe(
    serializeCatalog(completion.catalog, { pretty: false }),
  );

  await view.key("s");
  await view.key(keys.clear);
  await view.key("retry.json");
  await view.key(keys.enter);
  await view.key("f");

  expect(attempts).toBe(2);
  expect(view.files).toEqual([resolve("retry.json")]);
});

test("help is dismissible and a small terminal suppresses hidden actions", async () => {
  const view = await screen({
    ...completion,
    outputPath: join(tmpdir(), "catalog.json"),
  });

  await view.key("?");

  expect(view.text()).toContain("Help");

  await view.key(keys.end);

  expect(view.text()).toContain("Ctrl+C");

  await view.key(keys.escape);

  expect(view.text()).toContain('Phone, "Gold"');

  await view.resize(24, 5);

  expect(view.text().toLowerCase()).toContain("resize");
  expect(view.text().trimEnd().split("\n").length).toBeLessThanOrEqual(5);

  for (const key of ["j", "c", "s", "o", "f", "p", keys.enter])
    await view.key(key);

  expect(view.copies).toEqual([]);
  expect(view.saves).toEqual([]);
  expect(view.files).toEqual([]);
  expect(view.folders).toEqual([]);

  await view.resize(40, 15);

  expect(view.text()).toContain("Terminal too small");

  await view.key("j");

  expect(view.copies).toEqual([]);

  await view.resize(40, 16);

  expect(view.text()).toContain("Catalog complete");
  expect(view.text()).not.toContain("Terminal too small");

  await view.key("q");

  expect(view.exits).toEqual([0]);
});

test("pending action excludes duplicates and other actions; failure permits retry", async () => {
  let rejectAction: ((error: Error) => void) | undefined;
  let calls = 0;
  const view = await screen(
    { ...completion, outputPath: join(tmpdir(), "catalog.json") },
    {
      desktop: {
        copy: () =>
          Effect.callback<void, DesktopError>((resume) => {
            calls++;
            rejectAction = (cause) =>
              resume(
                Effect.fail(
                  new DesktopError({ message: cause.message, cause }),
                ),
              );
          }),
        openFolder: () =>
          Effect.sync(() => {
            calls++;
          }),
        openFile: () =>
          Effect.sync(() => {
            calls++;
          }),
      },
    },
  );

  for (const key of ["j", "j", "v", "t", "o", "f", "s", "c"])
    await view.key(key);

  expect(calls).toBe(1);
  expect(view.saves).toEqual([]);

  rejectAction?.(new Error("clipboard unavailable"));
  await tick();

  expect(view.text()).toContain("clipboard unavailable");

  await view.key("o");

  expect(calls).toBe(2);

  await view.key("q");

  expect(view.exits).toEqual([0]);
});

test("alternate copy failure stays local and allows another format", async () => {
  const copies: string[] = [];
  const view = await screen(
    { ...completion, format: "csv" },
    {
      desktop: {
        copy: (text) =>
          Effect.gen(function* () {
            copies.push(text);

            if (copies.length === 1)
              yield* Effect.fail(
                new DesktopError({
                  message: "clipboard unavailable",
                  cause: undefined,
                }),
              );
          }),
      },
    },
  );

  await view.key("t");

  expect(view.text()).toContain("clipboard unavailable");
  expect(view.exits).toEqual([]);

  await view.key("j");

  expect(view.text()).toContain("JSON copied");
  expect(copies).toEqual([
    serializeCatalog(completion.catalog, { format: "tsv" }),
    serializeCatalog(completion.catalog, { format: "json" }),
  ]);
});

test("unmount interrupts an outstanding desktop action", async () => {
  let interrupted = false;
  let started = false;
  const view = await screen(completion, {
    desktop: {
      copy: () =>
        Effect.callback<void>(() => {
          started = true;

          return Effect.sync(() => {
            interrupted = true;
          });
        }),
    },
  });

  await view.key("j");

  expect(started).toBe(true);

  view.instance.unmount();
  await tick();

  expect(interrupted).toBe(true);
  expect(view.text()).not.toContain("JSON copied");
});

for (const exit of ["close", "stop"] as const) {
  test(`${exit} waits for outstanding desktop finalizers`, async () => {
    const streams = terminalStreams();
    let release: (() => void) | undefined;
    let started = false;
    let finalized = false;
    const ui = createTerminalUI({
      stdin: streams.input as unknown as NodeJS.ReadStream,
      stdout: streams.output as unknown as NodeJS.WriteStream,
      onCancel() {},
      desktop: {
        copy: () =>
          Effect.gen(function* () {
            started = true;
            yield* Effect.never;
          }).pipe(
            Effect.ensuring(
              Effect.callback<void>((resume) => {
                release = () => {
                  finalized = true;
                  resume(Effect.void);
                };
              }),
            ),
          ),
        openFolder: () => Effect.void,
        openFile: () => Effect.void,
      },
    });
    let completed = false;
    const completionResult = Effect.runPromise(ui.complete(completion)).then(
      (code) => {
        completed = true;

        return code;
      },
    );

    await tick();
    streams.input.write("j");
    await tick();

    expect(started).toBe(true);

    if (exit === "close") streams.input.write("q");

    let stopped = false;

    await tick();

    const stopResult = Effect.runPromise(ui.stop()).then(() => {
      stopped = true;
    });

    await tick();

    expect(release).toBeDefined();
    expect(completed).toBe(false);
    expect(stopped).toBe(false);
    expect(finalized).toBe(false);

    release?.();

    expect(await completionResult).toBe(exit === "close" ? 0 : 130);

    await stopResult;

    expect(finalized).toBe(true);
    expect(streams.raw.at(-1)).toBe(false);

    streams.input.destroy();
    streams.output.destroy();
  });
}

function rendererWithExit(waitUntilExit: () => Promise<void>): typeof render {
  return () => ({
    rerender() {},
    unmount() {},
    clear() {},
    cleanup() {},
    waitUntilRenderFlush: () => Promise.resolve(),
    waitUntilExit,
  });
}

test("renderer teardown rejection settles both completion and stop", async () => {
  const failure = new Error("renderer teardown failed");
  const ui = createTerminalUI({
    onCancel() {},
    renderTerminal: rendererWithExit(() => Promise.reject(failure)),
  });
  const completed = Effect.runPromise(Effect.exit(ui.complete(completion)));
  const stopped = await Effect.runPromise(Effect.exit(ui.stop()));
  const result = await completed;

  expect(Exit.isFailure(result)).toBe(true);
  expect(Exit.isFailure(stopped)).toBe(true);

  if (Exit.isFailure(result))
    expect(String(result.cause)).toContain(failure.message);
});

test("stop joins renderer teardown when the completion fiber is interrupted", async () => {
  let release: (() => void) | undefined;
  const ui = createTerminalUI({
    onCancel() {},
    renderTerminal: rendererWithExit(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    ),
  });
  const completed = Effect.runFork(ui.complete(completion));

  await tick();

  const interruption = Effect.runPromise(Fiber.interrupt(completed));

  await tick();

  expect(release).toBeDefined();

  let stopped = false;
  const stopping = Effect.runPromise(ui.stop()).then(() => {
    stopped = true;
  });

  await tick();

  expect(stopped).toBe(false);

  release?.();
  await Promise.all([interruption, stopping]);

  expect(stopped).toBe(true);
});
