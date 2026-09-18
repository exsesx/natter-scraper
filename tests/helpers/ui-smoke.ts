import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Effect } from "effect";
import { DesktopError } from "../../src/desktop";
import { serializeCatalog } from "../../src/format";
import type { Catalog, OutputFormat } from "../../src/types";
import { createTerminalUI } from "../../src/ui";

const catalog: Catalog = {
  results: Array.from({ length: 40 }, (_, index) => ({
    name: `Browser product ${String(index + 1).padStart(2, "0")}`,
    description: `Details for product ${index + 1}. A description retained in full when inspecting the selected result.`,
    price: 12.34,
  })),
  total: 493.6,
};
const format = (process.argv
  .find((arg) => arg.startsWith("--format="))
  ?.split("=")[1] ?? "json") as OutputFormat;
const outputPath = join(tmpdir(), "a folder", "catalog.json");

// Large PTY fixture. Desktop actions are mocked and never affect this machine.
let ui: ReturnType<typeof createTerminalUI>;

ui = createTerminalUI({
  onCancel() {
    Effect.runFork(ui.stop());
    process.exitCode = 130;
  },
  desktop: {
    copy: (text) =>
      Effect.gen(function* () {
        const outputs = (["json", "csv", "tsv"] as const).flatMap((format) =>
          [false, true].map((pretty) =>
            serializeCatalog(catalog, { format, pretty }),
          ),
        );

        if (![outputPath, ...outputs].includes(text))
          yield* Effect.fail(
            new DesktopError({
              message: "Unexpected clipboard bytes",
              cause: undefined,
            }),
          );
      }),
    openFile: (path) =>
      isAbsolute(path) && path === outputPath
        ? Effect.void
        : Effect.fail(
            new DesktopError({
              message: "Unexpected file path",
              cause: undefined,
            }),
          ),
    openFolder: (path) =>
      isAbsolute(path) && path === outputPath
        ? Effect.void
        : Effect.fail(
            new DesktopError({
              message: "Unexpected folder path",
              cause: undefined,
            }),
          ),
  },
});

if (process.argv.includes("--running")) {
  ui.update({
    phase: "scraping",
    pages: 4,
    discoveredProducts: 6,
    processedProducts: 2,
    queued: 3,
    active: 1,
    retries: 1,
  });
} else {
  await new Promise((resolve) => setTimeout(resolve, 150));

  process.exitCode = await Effect.runPromise(
    ui.complete({
      catalog,
      format,
      pretty: true,
      outputPath,
      productCount: 40,
      elapsedMs: 100,
    }),
  );
}
