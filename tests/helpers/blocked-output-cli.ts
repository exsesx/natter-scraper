import { Effect } from "effect";
import { finishCli, runCli } from "../../src/cli";

// A large valid catalog fills a pipe whose reader deliberately stops consuming.
finishCli(
  await Effect.runPromise(
    runCli(["--no-interactive"], {
      crawl() {
        return Effect.succeed({
          productCount: 50_000,
          pages: 1,
          catalog: {
            results: Array.from({ length: 50_000 }, (_, index) => ({
              name: `Product ${index}`,
              description: "A large fixture record for a blocked output pipe",
              price: 1,
            })),
            total: 50_000,
          },
        });
      },
    }),
  ),
);
