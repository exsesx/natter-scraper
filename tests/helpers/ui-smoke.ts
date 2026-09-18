import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Effect } from "effect";
import { DesktopError } from "../../src/desktop";
import { serializeCatalog } from "../../src/format";
import type { Catalog, OutputFormat } from "../../src/types";
import { createTerminalUI } from "../../src/ui";

const catalog: Catalog = {
  results: [{ name: "Phone", description: "Test phone", price: 12.34 }],
  total: 12.34,
};
const format = (process.argv
  .find((arg) => arg.startsWith("--format="))
  ?.split("=")[1] ?? "json") as OutputFormat;
const output = serializeCatalog(catalog, { format });
const outputPath = join(tmpdir(), "a folder", "catalog.json");

// Manual PTY fixture. Desktop actions are mocked and never affect this machine.
let ui: ReturnType<typeof createTerminalUI>;

ui = createTerminalUI({
  onCancel() {
    Effect.runFork(ui.stop());
    process.exitCode = 130;
  },
  desktop: {
    copy: (text) =>
      Effect.gen(function* () {
        const outputs = (["json", "csv", "tsv"] as const).map((format) =>
          serializeCatalog(catalog, { format }),
        );

        if (![outputPath, ...outputs].includes(text))
          yield* Effect.fail(
            new DesktopError({
              message: "Unexpected clipboard bytes",
              cause: undefined,
            }),
          );
      }),
    openFolder: (path) =>
      isAbsolute(path)
        ? Effect.void
        : Effect.fail(
            new DesktopError({ message: "Nonabsolute path", cause: undefined }),
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
  await Effect.runPromise(ui.clear());

  process.stdout.write(output);

  process.exitCode = await Effect.runPromise(
    ui.complete({
      catalog,
      output,
      format,
      pretty: false,
      outputPath,
      productCount: 2,
      elapsedMs: 100,
    }),
  );
}
