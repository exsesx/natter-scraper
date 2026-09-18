import { Effect } from "effect";
import { finishCli, runCli } from "../../src/cli";
import { crawl } from "../../src/crawl";

// Only this test entry point accepts a fixture URL. The shipped CLI stays scoped.
const baseUrl = process.env.FIXTURE_URL;

if (!baseUrl) throw new Error("FIXTURE_URL is required by the test helper");

finishCli(
  await Effect.runPromise(
    runCli(process.argv.slice(2), {
      crawl: (options) =>
        crawl({
          ...options,
          baseUrl,
          retryDelayMs: 1,
          requestTimeoutMs: 5_000,
          runTimeoutMs: 30_000,
        }),
    }),
  ),
);
